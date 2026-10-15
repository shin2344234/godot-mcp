extends CharacterBody2D
## Minimal top-down-ish player controller used by the sample scene.

@export var speed: float = 200.0
@export var jump_velocity: float = -400.0

var gravity: float = float(ProjectSettings.get_setting("physics/2d/default_gravity", 980.0))


func _physics_process(delta: float) -> void:
	if not is_on_floor():
		velocity.y += gravity * delta
	if Input.is_action_just_pressed("jump") and is_on_floor():
		velocity.y = jump_velocity
	var direction: float = Input.get_axis("move_left", "move_right")
	velocity.x = direction * speed
	move_and_slide()
