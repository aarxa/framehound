extends Node
## framehound's driver for Godot's third-person shooter demo (github.com/godotengine/tps-demo): it skips the menu and
## plays the level the same way every run, so the framehound layer can learn the game and watch can draw the same
## frames twice. It's an autoload added by override.cfg (both files go in the demo's folder, see native/README.md),
## so none of the demo's own files change.
##
## Options after a lone `--` on Godot's command line:
##   --frames N        quit after N frames of play (default 900)
##   --bug inside      ship the player robot inside out (its materials cull the wrong side)
##   --bug wrongtex    ship the player robot with a cargo container's texture, as if the wrong file had shipped

var frames := 900
var bug := ""
var frame := 0
var input_sync: Node = null


func _ready() -> void:
	frames = int(_arg("--frames", "900"))
	bug = _arg("--bug", "")
	# A window, no vsync, and nothing that carries history from frame to frame (an upscaler, TAA, volumetric fog's
	# reprojection), which would drift when the layer draws a frame several times.
	var settings: Node = get_node(^"/root/Settings")
	settings.config_file.set_value("video", "display_mode", Window.MODE_WINDOWED)
	settings.config_file.set_value("video", "vsync", DisplayServer.VSYNC_DISABLED)
	settings.config_file.set_value("video", "max_fps", 0)
	settings.config_file.set_value("video", "resolution_scale", 1.0)
	settings.config_file.set_value("video", "scale_filter", Viewport.SCALING_3D_MODE_BILINEAR)
	settings.config_file.set_value("rendering", "taa", false)
	settings.config_file.set_value("rendering", "volumetric_fog", false)
	_start.call_deferred()


# Load the level straight away and on this thread, so it always starts on the same frame (the menu loads it on a
# thread and then waits on a timer), then undo the random choices the level made while loading.
func _start() -> void:
	var main: Node = get_tree().current_scene
	main.change_scene_to_packed(load("res://level/level.tscn"))
	var level: Node = main.get_child(main.get_child_count() - 1)
	seed(1)
	# the player at the first spawn point, not a random one
	var player: Node3D = level.get_node(^"SpawnedNodes/1")
	player.global_transform = level.get_node(^"PlayerSpawnpoints").get_child(0).global_transform
	input_sync = player.get_node(^"InputSynchronizer")
	# The player turns the camera on mouse motion; ignore the real mouse, so moving it over the window can't change
	# the run (override.cfg also keeps the window from taking keyboard focus).
	input_sync.set_process_input(false)
	var camera = player.get_node(^"CameraBase/CameraRot/SpringArm3D/Camera3D")
	camera.noise.seed = 1
	# the same forklift models every run
	var k := 0
	for forklift in level.get_node(^"FlyingForklifts").get_children():
		if forklift.get_child_count() == 0 or not forklift is Node3D:
			continue
		var models: Array[Node] = forklift.get_child(0).get_children()
		for m in models.size():
			models[m].visible = m == k % models.size()
		k += 1
	# the debug overlay shows the frame rate and memory, which differ from run to run
	var debug: CanvasItem = level.get_node(^"Debug")
	debug.visible = false
	debug.set_process(false)
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE  # the game captures the mouse; leave it free
	if bug != "":
		_ship_bug(player)


# A bug in the player robot's materials, for testing watch.
func _ship_bug(player: Node) -> void:
	var container: Texture2D = load("res://level/textures/props/container1_albedo.png")
	for mesh: MeshInstance3D in player.find_children("*", "MeshInstance3D", true, false):
		for s in mesh.get_surface_override_material_count():
			var m := mesh.get_active_material(s) as StandardMaterial3D
			if m == null:
				continue
			m = m.duplicate()
			if bug == "inside":
				m.cull_mode = BaseMaterial3D.CULL_FRONT
			elif bug == "wrongtex":
				m.albedo_texture = container
			mesh.set_surface_override_material(s, m)


# Walk forward, always turning a little, more one way then the other, looking up and down a little, and jump now
# and then.
func _process(_delta: float) -> void:
	if input_sync == null:
		return
	frame += 1
	Input.action_press(&"move_forward")
	if frame % 240 == 120:
		Input.action_press(&"jump")
	else:
		Input.action_release(&"jump")
	input_sync.rotate_camera(Vector2(0.005 + 0.012 * sin(frame * 0.011), 0.002 * sin(frame * 0.007)))
	if frame >= frames:
		get_tree().quit()


func _arg(key: String, default: String) -> String:
	var args := OS.get_cmdline_user_args()
	var i := args.find(key)
	return args[i + 1] if i >= 0 and i + 1 < args.size() else default
