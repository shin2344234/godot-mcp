class_name Enemy
extends Area2D
## A global script class, so tests can add nodes by script class name (node.add type "Enemy").

enum Kind { SLIME, BAT, GHOST }

@export var damage: int = 10
@export var kind: Kind = Kind.SLIME
@export var target: Node2D
