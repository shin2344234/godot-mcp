@tool
extends RefCounted
## ClassDB introspection used by the docs tools when the class reference index is unavailable.
##
## Registered in core/methods.gd (MODULES). `methods()` maps each bridge-protocol method
## this module implements to a descriptor (see the comment on Methods.MODULES for kinds).


static func methods() -> Dictionary:
	return {}
