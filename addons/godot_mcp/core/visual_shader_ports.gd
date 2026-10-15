@tool
extends RefCounted
## Port names for VisualShader editing (ops/visual_ops.gd), copied from Godot 4.7.2's
## scene/resources/visual_shader.cpp (VisualShaderNodeInput::ports and
## VisualShaderNodeOutput::ports).
##
## Why a copy: the engine does not expose port names or counts to scripts
## (VisualShaderNode.get_input_port_count / get_input_port_name are C++-only), and the
## inspector hint that lists valid `input_name` values is only filled in inside the editor.
## With these tables we can validate VisualShaderNodeInput.input_name with did-you-mean,
## accept Output-node ports by name ("albedo"), and show readable port names in reads.
## Keys are "<shader mode>/<shader type>" with the lower-case enum names. Regenerate when
## upgrading Godot (OUTPUT_PORTS order is the port index order).

## Valid VisualShaderNodeInput.input_name values per mode/type.
const INPUT_NAMES: Dictionary = {
	"spatial/vertex": "binormal,camera_direction_world,camera_position_world,camera_visible_layers,clip_space_far,color,custom0,custom1,custom2,custom3,exposure,eye_offset,in_shadow_pass,instance_custom,instance_id,inv_projection_matrix,inv_view_matrix,model_matrix,modelview_matrix,node_position_view,node_position_world,normal,output_is_srgb,point_size,projection_matrix,roughness,tangent,time,uv,uv2,vertex,vertex_id,is_multiview,view_index,view_matrix,view_mono_left,view_right,viewport_size",
	"spatial/fragment": "binormal,camera_direction_world,camera_position_world,camera_visible_layers,clip_space_far,color,exposure,eye_offset,fragcoord,front_facing,in_shadow_pass,inv_projection_matrix,inv_view_matrix,model_matrix,node_position_view,node_position_world,normal,output_is_srgb,point_coord,projection_matrix,screen_uv,tangent,time,uv,uv2,vertex,view,is_multiview,view_index,view_matrix,view_mono_left,view_right,viewport_size",
	"spatial/light": "albedo,alpha,attenuation,backlight,clip_space_far,diffuse,exposure,fragcoord,in_shadow_pass,inv_projection_matrix,inv_view_matrix,light,light_color,light_is_directional,metallic,model_matrix,normal,output_is_srgb,projection_matrix,roughness,screen_uv,specular,specular_amount,time,uv,uv2,view,view_matrix,viewport_size,is_multiview",
	"canvas_item/vertex": "at_light_pass,canvas_matrix,color,custom0,custom1,instance_custom,instance_id,model_matrix,point_size,screen_matrix,texture_pixel_size,time,uv,vertex,vertex_id",
	"canvas_item/fragment": "at_light_pass,color,fragcoord,normal_texture,point_coord,region_rect,screen_pixel_size,screen_uv,specular_shininess,specular_shininess_texture,texture,texture_pixel_size,time,uv,vertex",
	"canvas_item/light": "color,fragcoord,light,light_color,light_direction,light_energy,light_is_directional,light_position,light_vertex,normal,point_coord,screen_uv,shadow,specular_shininess,texture,texture_pixel_size,time,uv",
	"particles/start": "active,color,custom,delta,emission_transform,index,lifetime,number,random_seed,time,transform,velocity",
	"particles/start_custom": "active,color,custom,delta,emission_transform,index,lifetime,number,random_seed,time,transform,velocity",
	"particles/process": "active,attractor_force,color,custom,delta,emission_transform,index,lifetime,number,random_seed,restart,time,transform,velocity",
	"particles/process_custom": "active,attractor_force,color,custom,delta,emission_transform,index,lifetime,number,random_seed,restart,time,transform,velocity",
	"particles/collide": "active,attractor_force,collision_depth,collision_normal,color,custom,delta,emission_transform,index,lifetime,number,random_seed,restart,time,transform,velocity",
	"sky/sky": "at_cubemap_pass,at_half_res_pass,at_quarter_res_pass,eyedir,fragcoord,half_res_color,light0_color,light0_direction,light0_enabled,light0_energy,light1_color,light1_direction,light1_enabled,light1_energy,light2_color,light2_direction,light2_enabled,light2_energy,light3_color,light3_direction,light3_enabled,light3_energy,position,quarter_res_color,radiance,screen_uv,sky_coords,time",
	"fog/fog": "object_position,sdf,size,time,uvw,world_position",
	"texture_blit/texture_blit": "fragcoord,modulate,uv,source_texture0,source_texture1,source_texture2,source_texture3",
}

## Input ports of the Output node (id 0) per mode/type, in port-index order, as
## "Name:port_type". Particles graphs have their own output nodes and are not listed.
const OUTPUT_PORTS: Dictionary = {
	"spatial/vertex": "Vertex:vector_3d,Normal:vector_3d,Tangent:vector_3d,Binormal:vector_3d,UV:vector_2d,UV2:vector_2d,Color:vector_3d,Alpha:scalar,Roughness:scalar,Point Size:scalar,Model View Matrix:transform,Projection Matrix:transform",
	"spatial/fragment": "Albedo:vector_3d,Alpha:scalar,Metallic:scalar,Roughness:scalar,Specular:scalar,Emission:vector_3d,AO:scalar,AO Light Affect:scalar,Normal:vector_3d,Normal Map:vector_3d,Normal Map Depth:scalar,Rim:scalar,Rim Tint:scalar,Clearcoat:scalar,Clearcoat Roughness:scalar,Anisotropy:scalar,Anisotropy Flow:vector_2d,Subsurf Scatter:scalar,Backlight:vector_3d,Alpha Scissor Threshold:scalar,Alpha Hash Scale:scalar,Alpha AA Edge:scalar,Alpha UV:vector_2d,Depth:scalar,Bent Normal Map:vector_3d",
	"spatial/light": "Diffuse:vector_3d,Specular:vector_3d,Alpha:scalar",
	"canvas_item/vertex": "Vertex:vector_2d,UV:vector_2d,Color:vector_3d,Alpha:scalar,Point Size:scalar",
	"canvas_item/fragment": "Color:vector_3d,Alpha:scalar,Normal:vector_3d,Normal Map:vector_3d,Normal Map Depth:scalar,Light Vertex:vector_3d,Shadow Vertex:vector_2d",
	"canvas_item/light": "Light:vector_3d,Light Alpha:scalar,Shadow Modulate:vector_3d",
	"sky/sky": "Color:vector_3d,Alpha:scalar,Fog:vector_3d,Fog Alpha:scalar",
	"fog/fog": "Density:scalar,Albedo:vector_3d,Emission:vector_3d",
	"texture_blit/texture_blit": "Color0:vector_4d,Color1:vector_4d,Color2:vector_4d,Color3:vector_4d",
}


## Valid input names for a mode/type key ("spatial/fragment"), or [] if unknown.
static func input_names(key: String) -> PackedStringArray:
	var s: String = INPUT_NAMES.get(key, "")
	return s.split(",") if not s.is_empty() else PackedStringArray()


## Output-node port names for a mode/type key, in index order ([] when not tabulated).
static func output_ports(key: String) -> PackedStringArray:
	var s: String = OUTPUT_PORTS.get(key, "")
	var out: PackedStringArray = []
	if s.is_empty():
		return out
	for entry: String in s.split(","):
		out.append(entry.get_slice(":", 0))
	return out


## Index of an Output-node port given by name ("Albedo", "albedo", "normal_map"), or -1.
static func output_port_index(key: String, port_name: String) -> int:
	var wanted: String = port_name.to_lower().replace("_", " ").strip_edges()
	var names: PackedStringArray = output_ports(key)
	for i: int in names.size():
		if names[i].to_lower() == wanted:
			return i
	return -1
