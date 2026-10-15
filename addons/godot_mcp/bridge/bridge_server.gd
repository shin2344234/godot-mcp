@tool
extends RefCounted
## WebSocket server for the editor bridge (docs/bridge-protocol.md section 1).
##
## Design notes:
## * Polled from EditorPlugin._process() on the main thread. All editor APIs must be called
##   from the main thread, so a polled server is simpler and safer than a worker thread.
## * Binds to 127.0.0.1 only. TCPServer.listen() defaults to "*" (all interfaces), which
##   would expose full editor control to the network, so we always pass the address.
## * Every connection must authenticate with a `hello` frame carrying the token from the
##   session file within HANDSHAKE_TIMEOUT_MS, otherwise it is closed (4001 / 4002).
## * Requests are handled by a dispatcher Callable `(method: String, params) -> Dictionary`
##   that returns {"result": ...} or {"error": ...}. It may be a coroutine; responses are
##   sent whenever it completes.

const Constants := preload("../core/constants.gd")
const R := preload("../core/mcp_result.gd")
const Codec := preload("../core/variant_codec.gd")

const BIND_ADDRESS: String = "127.0.0.1"
const HANDSHAKE_TIMEOUT_MS: int = 5000
const CLOSE_UNAUTHORIZED: int = 4001
const CLOSE_HANDSHAKE_TIMEOUT: int = 4002
## Large enough for big scene dumps / script sources; the default is only 64 KiB.
const INBOUND_BUFFER: int = 4 * 1024 * 1024
const OUTBOUND_BUFFER: int = 8 * 1024 * 1024

var port: int = -1
var token: String = ""

var _tcp := TCPServer.new()
## Each client: {"id": int, "peer": WebSocketPeer, "authed": bool, "accepted_ms": int, "closing": bool}
var _clients: Array[Dictionary] = []
var _next_client_id: int = 1
var _dispatcher: Callable
## Returns the `welcome` payload (godot/plugin versions, project info).
var _welcome_provider: Callable


func _init(dispatcher: Callable, welcome_provider: Callable) -> void:
	_dispatcher = dispatcher
	_welcome_provider = welcome_provider


## Starts listening on `base_port` or one of the next PORT_FALLBACK_COUNT ports.
## Generates a fresh token. Returns OK or the last listen error.
func start(base_port: int) -> int:
	token = Crypto.new().generate_random_bytes(32).hex_encode()
	var last_err: int = ERR_CANT_CREATE
	for candidate: int in range(base_port, base_port + Constants.PORT_FALLBACK_COUNT + 1):
		if candidate > 65535:
			break
		last_err = _tcp.listen(candidate, BIND_ADDRESS)
		if last_err == OK:
			port = candidate
			return OK
	port = -1
	return last_err


func is_listening() -> bool:
	return _tcp.is_listening()


func client_count() -> int:
	return _clients.size()


func stop() -> void:
	for c: Dictionary in _clients:
		var peer: WebSocketPeer = c["peer"]
		# 1001 = "going away" (editor closing / plugin disabled).
		peer.close(1001, "editor plugin stopped")
		peer.poll()
	_clients.clear()
	_tcp.stop()
	port = -1


## Call every frame: accepts connections, advances handshakes, reads frames.
func poll() -> void:
	if not _tcp.is_listening():
		return
	while _tcp.is_connection_available():
		var conn: StreamPeerTCP = _tcp.take_connection()
		if conn == null:
			break
		var peer := WebSocketPeer.new()
		peer.inbound_buffer_size = INBOUND_BUFFER
		peer.outbound_buffer_size = OUTBOUND_BUFFER
		if peer.accept_stream(conn) != OK:
			conn.disconnect_from_host()
			continue
		_clients.append({"id": _next_client_id, "peer": peer, "authed": false, "accepted_ms": Time.get_ticks_msec(), "closing": false})
		_next_client_id += 1

	var now: int = Time.get_ticks_msec()
	# Iterate over a copy: handlers may close clients while we loop.
	for c: Dictionary in _clients.duplicate():
		var peer: WebSocketPeer = c["peer"]
		peer.poll()
		var state: int = peer.get_ready_state()
		if state == WebSocketPeer.STATE_CLOSED:
			_clients.erase(c)
			continue
		if state == WebSocketPeer.STATE_OPEN:
			while peer.get_available_packet_count() > 0 and not c["closing"]:
				var packet: PackedByteArray = peer.get_packet()
				_on_frame(c, packet.get_string_from_utf8())
		if not c["authed"] and not c["closing"] and now - int(c["accepted_ms"]) > HANDSHAKE_TIMEOUT_MS:
			_close(c, CLOSE_HANDSHAKE_TIMEOUT, "handshake timeout")


func _close(c: Dictionary, code: int, reason: String) -> void:
	c["closing"] = true
	var peer: WebSocketPeer = c["peer"]
	if peer.get_ready_state() == WebSocketPeer.STATE_OPEN:
		peer.close(code, reason)
	else:
		# Still in the HTTP upgrade phase: there is no WebSocket to send a close frame on.
		peer.close(-1)


func _on_frame(c: Dictionary, text: String) -> void:
	var msg: Variant = JSON.parse_string(text)
	if not c["authed"]:
		_handle_hello(c, msg)
		return
	if not msg is Dictionary:
		_send(c, {"type": "response", "id": null, "error": R.err(R.BAD_PARAMS, "Frame is not a JSON object: %s" % text.left(200))["error"]})
		return
	var d: Dictionary = msg
	match str(d.get("type", "")):
		"request":
			_handle_request(c, d)
		"hello":
			# Re-sending hello on an authenticated socket is harmless; answer again.
			_handle_hello(c, d)
		_:
			_send(c, {"type": "response", "id": _normalize_id(d.get("id")), "error": R.err(R.BAD_PARAMS, "Unknown message type '%s'; expected \"request\"." % str(d.get("type", "")))["error"]})


func _handle_hello(c: Dictionary, msg: Variant) -> void:
	if not msg is Dictionary or str((msg as Dictionary).get("type", "")) != "hello" \
			or not _secure_equals(str((msg as Dictionary).get("token", "")), token):
		_close(c, CLOSE_UNAUTHORIZED, "unauthorized")
		return
	c["authed"] = true
	var welcome: Dictionary = {"type": "welcome", "protocol": Constants.PROTOCOL_VERSION}
	welcome.merge(_welcome_provider.call(), false)
	_send(c, welcome)


func _handle_request(c: Dictionary, d: Dictionary) -> void:
	var id: Variant = _normalize_id(d.get("id"))
	var method: Variant = d.get("method")
	var response: Dictionary = {"type": "response", "id": id}
	if not method is String or (method as String).is_empty():
		response["error"] = R.err(R.BAD_PARAMS, "Request is missing 'method' (string).")["error"]
		_send(c, response)
		return
	# `await` works whether or not the dispatcher is a coroutine.
	var outcome: Variant = await _dispatcher.call(method, d.get("params", {}))
	if outcome is Dictionary and (outcome as Dictionary).has("error"):
		response["error"] = outcome["error"]
	elif outcome is Dictionary and (outcome as Dictionary).has("result"):
		response["result"] = outcome["result"]
	else:
		response["error"] = R.err(R.INTERNAL, "Handler for '%s' returned no result." % method)["error"]
	_send(c, response)


## Sends an event frame to every authenticated client, e.g. runtime messages relayed from
## a game started in the editor: {"type": "event", "event": "game.message", "data": {...}}.
func broadcast_event(event: String, data: Dictionary) -> void:
	for c: Dictionary in _clients:
		if c["authed"] and not c["closing"]:
			_send(c, {"type": "event", "event": event, "data": data})


func _send(c: Dictionary, payload: Dictionary) -> void:
	var peer: WebSocketPeer = c["peer"]
	if peer.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return
	var err: int = peer.send_text(Codec.to_json(payload))
	if err != OK and payload.get("type") == "response":
		# Most likely the response exceeded the outbound buffer; tell the client instead of
		# leaving the request hanging.
		peer.send_text(Codec.to_json({"type": "response", "id": payload.get("id"),
			"error": R.err(R.INTERNAL, "Could not send the response (%s); it may be too large. Narrow the request (e.g. scene.tree with smaller depth/max_nodes, or node.get with a 'properties' list)." % error_string(err))["error"]}))


## JSON numbers arrive as floats; echo integral ids back as ints so "id": 7 stays 7.
static func _normalize_id(id: Variant) -> Variant:
	if id is float and is_finite(id) and float(id) == floorf(id):
		return int(id)
	return id


## Compares two strings in time independent of where they differ (always walks the full
## expected length), so the token cannot be guessed byte by byte from response timing.
static func _secure_equals(given: String, expected: String) -> bool:
	var a: PackedByteArray = given.to_utf8_buffer()
	var b: PackedByteArray = expected.to_utf8_buffer()
	var diff: int = a.size() ^ b.size()
	for i: int in range(b.size()):
		var x: int = a[i] if i < a.size() else 0
		diff |= x ^ b[i]
	return diff == 0 and not expected.is_empty()
