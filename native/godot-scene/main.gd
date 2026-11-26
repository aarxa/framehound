extends Node3D
## framehound's Godot test scene: a courtyard with a brick tower, a wall with a gap, crates, barrels, turning statues on
## pedestals, a figure and a glass case, under a sky, with the sun casting shadows. Everything is built here, with
## textures drawn in code, so the project needs no asset files. It's animated by frame count, not by time, so two runs
## draw the same frames.
##
## Options after a lone `--` on Godot's command line:
##   --frames N        quit after N frames (default 720)
##   --bug wrongtex    a barrel is drawn with the ground's texture, as if the wrong file had shipped
##   --bug inside      the tower is drawn inside out

var camera: Camera3D
var spinners: Array[Node3D] = []
var figure: Node3D
var frame := 0
var frames := 720


func _ready() -> void:
	var args := OS.get_cmdline_user_args()
	var bug := _arg(args, "--bug", "")
	frames = int(_arg(args, "--frames", "720"))

	var ground_tex := _texture("ground", 256, _ground_pixel)
	var brick_tex := _texture("bricks", 256, _brick_pixel)
	var crate_tex := _texture("crate", 128, _crate_pixel)
	var barrel_tex := _texture("barrel", 128, _barrel_pixel)
	var stone_tex := _texture("stone", 128, _stone_pixel)

	_environment()
	_sun()

	_add("ground", _plane(60.0), _material(ground_tex, Vector3(15, 15, 1)), Vector3.ZERO)

	var tower := _material(brick_tex, Vector3(3, 2, 1))
	if bug == "inside":
		tower.cull_mode = BaseMaterial3D.CULL_FRONT
	_add("tower", _cylinder(1.6, 1.6, 6.0), tower, Vector3(0, 3, 0))
	_add("roof", _cylinder(0.0, 2.0, 2.0), _material(stone_tex, Vector3.ONE, Color(0.6, 0.25, 0.2)), Vector3(0, 7, 0))

	var wall := _material(brick_tex, Vector3(3, 2, 1))
	_add("wall left", _box(Vector3(6, 4, 0.8)), wall, Vector3(-5, 2, -8))
	_add("wall right", _box(Vector3(6, 4, 0.8)), wall, Vector3(5, 2, -8))
	_add("lintel", _box(Vector3(4, 1, 0.8)), wall, Vector3(0, 3.5, -8))

	var crate := _material(crate_tex)
	for p in [Vector3(6, 0.6, 4), Vector3(7.3, 0.6, 4.2), Vector3(6.6, 1.8, 4.1), Vector3(-6, 0.6, 5)]:
		_add("crate", _box(Vector3(1.2, 1.2, 1.2)), crate, p)

	var barrel := _material(barrel_tex)
	var positions := [Vector3(-4, 0.7, -3), Vector3(-5.2, 0.7, -2.4), Vector3(4.5, 0.7, -4)]
	for i in positions.size():
		var m := barrel
		if bug == "wrongtex" and i == 0:
			m = _material(ground_tex)
		_add("barrel", _cylinder(0.5, 0.5, 1.4), m, positions[i])

	var stone := _material(stone_tex)
	var statues: Array[Mesh] = [_torus(0.35, 0.7), _sphere(0.6), _prism(1.0)]
	var colours := [Color(0.9, 0.75, 0.3), Color(0.5, 0.7, 0.9), Color(0.8, 0.4, 0.6)]
	var spots := [Vector3(8, 0, 0), Vector3(-8, 0, 0), Vector3(0, 0, 8)]
	for i in 3:
		_add("pedestal", _box(Vector3(1, 1, 1)), stone, spots[i] + Vector3(0, 0.5, 0))
		spinners.append(_add("statue", statues[i], _material(stone_tex, Vector3.ONE, colours[i]), spots[i] + Vector3(0, 1.7, 0)))

	figure = Node3D.new()
	figure.position = Vector3(-2, 0, 4)
	add_child(figure)
	var cloth := _material(stone_tex, Vector3.ONE, Color(0.25, 0.35, 0.7))
	_add("body", _capsule(0.35, 1.6), cloth, Vector3(0, 0.8, 0), figure)
	_add("head", _sphere(0.3), _material(null, Vector3.ONE, Color(0.85, 0.65, 0.5)), Vector3(0, 1.9, 0), figure)

	var glass := StandardMaterial3D.new()
	glass.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	glass.albedo_color = Color(0.6, 0.8, 1.0, 0.35)
	glass.roughness = 0.1
	_add("glass case", _box(Vector3(2, 2, 2)), glass, Vector3(3, 1, 7))
	_add("orb", _sphere(0.4), _material(null, Vector3.ONE, Color(1.0, 0.85, 0.2)), Vector3(3, 1, 7))

	camera = Camera3D.new()
	camera.fov = 60
	add_child(camera)
	_pose()


func _process(_delta: float) -> void:
	frame += 1
	_pose()
	if frame >= frames:
		get_tree().quit()


func _pose() -> void:
	var a := 0.3 + frame * 0.0035
	camera.position = Vector3(cos(a) * 15.0, 5.5, sin(a) * 15.0)
	camera.look_at(Vector3(0, 1.5, 0))
	for i in spinners.size():
		spinners[i].rotation = Vector3(0.3 * i, frame * 0.02 * (1 + i), 0)
	figure.rotation.y = frame * 0.01
	figure.position.y = 0.08 * sin(frame * 0.1)


func _environment() -> void:
	var sky := Sky.new()
	sky.sky_material = ProceduralSkyMaterial.new()
	var env := Environment.new()
	env.background_mode = Environment.BG_SKY
	env.sky = sky
	env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	env.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	var world := WorldEnvironment.new()
	world.environment = env
	add_child(world)


func _sun() -> void:
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 35, 0)
	sun.light_energy = 1.2
	sun.shadow_enabled = true
	sun.directional_shadow_mode = DirectionalLight3D.SHADOW_PARALLEL_2_SPLITS
	sun.directional_shadow_max_distance = 60.0
	add_child(sun)


func _add(node_name: String, mesh: Mesh, material: Material, pos: Vector3, parent: Node = self) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	mi.name = node_name
	mi.mesh = mesh
	mi.material_override = material
	mi.position = pos
	parent.add_child(mi)
	return mi


func _material(tex: Texture2D, uv := Vector3.ONE, colour := Color.WHITE) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_texture = tex
	m.albedo_color = colour
	m.uv1_scale = uv
	m.roughness = 0.85
	return m


func _plane(size: float) -> PlaneMesh:
	var m := PlaneMesh.new()
	m.size = Vector2(size, size)
	return m


func _box(size: Vector3) -> BoxMesh:
	var m := BoxMesh.new()
	m.size = size
	return m


func _cylinder(top: float, bottom: float, height: float) -> CylinderMesh:
	var m := CylinderMesh.new()
	m.top_radius = top
	m.bottom_radius = bottom
	m.height = height
	return m


func _sphere(radius: float) -> SphereMesh:
	var m := SphereMesh.new()
	m.radius = radius
	m.height = radius * 2
	return m


func _capsule(radius: float, height: float) -> CapsuleMesh:
	var m := CapsuleMesh.new()
	m.radius = radius
	m.height = height
	return m


func _torus(inner: float, outer: float) -> TorusMesh:
	var m := TorusMesh.new()
	m.inner_radius = inner
	m.outer_radius = outer
	return m


func _prism(size: float) -> PrismMesh:
	var m := PrismMesh.new()
	m.size = Vector3(size, size, size)
	return m


func _texture(texture_name: String, n: int, pixel: Callable) -> ImageTexture:
	var img := Image.create(n, n, false, Image.FORMAT_RGBA8)
	for y in n:
		for x in n:
			img.set_pixel(x, y, pixel.call(x, y, n))
	img.generate_mipmaps()
	var tex := ImageTexture.create_from_image(img)
	tex.resource_name = texture_name
	return tex


func _ground_pixel(x: int, y: int, _n: int) -> Color:
	var c := Color(0.30, 0.45, 0.20) if (x / 32 + y / 32) % 2 == 0 else Color(0.36, 0.52, 0.24)
	if x % 32 == 0 or y % 32 == 0:
		c = Color(0.22, 0.30, 0.15)
	var speckle := ((x * 73856093) ^ (y * 19349663)) & 15
	return c.darkened(speckle / 150.0)


func _brick_pixel(x: int, y: int, _n: int) -> Color:
	var row := y / 16
	var bx := (x + 16 * (row % 2)) % 32
	if y % 16 < 2 or bx < 2:
		return Color(0.75, 0.72, 0.66)
	var shade := ((x + 16 * (row % 2)) / 32 * 7 + row * 13) % 5 / 25.0
	return Color(0.55 + shade, 0.22 + shade * 0.5, 0.16)


func _crate_pixel(x: int, y: int, n: int) -> Color:
	if x < 10 or y < 10 or x >= n - 10 or y >= n - 10 or abs(x - y) < 7:
		return Color(0.42, 0.28, 0.14)
	var wood := Color(0.62, 0.44, 0.24).darkened((y / 16) % 3 * 0.08)
	return wood.darkened(0.3) if y % 16 == 0 else wood


func _barrel_pixel(x: int, y: int, n: int) -> Color:
	if (y > n * 0.15 and y < n * 0.22) or (y > n * 0.78 and y < n * 0.85):
		return Color(0.25, 0.25, 0.28)
	return Color(0.55, 0.12, 0.10) if (x / 16) % 2 == 0 else Color(0.48, 0.10, 0.08)


func _stone_pixel(x: int, y: int, _n: int) -> Color:
	var v := 0.55 + 0.12 * sin(x * 0.21) * cos(y * 0.17) + 0.06 * sin((x + y) * 0.5)
	return Color(v, v * 0.97, v * 0.92)


func _arg(args: PackedStringArray, key: String, default: String) -> String:
	var i := args.find(key)
	return args[i + 1] if i >= 0 and i + 1 < args.size() else default
