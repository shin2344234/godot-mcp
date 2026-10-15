@tool
extends RefCounted
## "Did you mean ...?" suggestions for unknown class, property, node and method names.
##
## Uses Godot's built-in String.similarity() (Sorensen-Dice on bigrams) plus a bonus for
## case-insensitive substring matches, which catches the common LLM mistakes: wrong case
## ("sprite2d"), missing suffix ("Sprite"), or a near-miss typo ("Sprit2D").


## Returns up to `max_count` candidates most similar to `query`, best first.
static func suggest(query: String, candidates: Variant, max_count: int = 5) -> Array[String]:
	var q: String = query.to_lower()
	var scored: Array = []
	for c: Variant in candidates:
		var cand: String = str(c)
		var cl: String = cand.to_lower()
		var score: float = q.similarity(cl)
		if cl == q:
			score = 10.0
		elif not q.is_empty() and (cl.contains(q) or q.contains(cl)):
			score += 0.5
		if score >= 0.35:
			scored.append([score, cand])
	# Highest score first; shorter names win ties so "Sprite2D" beats "AnimatedSprite2D".
	scored.sort_custom(func(a: Array, b: Array) -> bool:
		if a[0] != b[0]:
			return a[0] > b[0]
		return str(a[1]).length() < str(b[1]).length())
	var out: Array[String] = []
	for entry: Array in scored:
		if out.size() >= max_count:
			break
		out.append(str(entry[1]))
	return out


## Formats suggestions for an error message: " Did you mean: A, B, C?" or "".
static func did_you_mean(suggestions: Array[String]) -> String:
	if suggestions.is_empty():
		return ""
	return " Did you mean: %s?" % ", ".join(suggestions)
