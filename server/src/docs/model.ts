/**
 * The compact docs index format (shared by the builder, the bundled @GDScript data,
 * project-class docs and search).
 *
 * Descriptions stay in raw Godot BBCode in the index (smaller, and conversion is cheap) and
 * are converted to Markdown only for what a tool actually returns.
 */

export type MemberKind = 'method' | 'property' | 'signal' | 'constant' | 'enum' | 'annotation' | 'utility' | 'constructor';
export type ClassKind = 'class' | 'builtin' | 'global' | 'project';

export interface DocMember {
  /** Kind. */
  k: MemberKind;
  /** Name. */
  n: string;
  /** Signature / declaration, GDScript-style ("func get_node(path: NodePath) -> Node"). */
  s?: string;
  /** Description (BBCode). */
  d?: string;
  /** For enum values (k "constant"): the enum they belong to. */
  e?: string;
}

export interface DocClass {
  /** Name ("Node2D", "@GDScript", "Vector2", project class_name). */
  n: string;
  /** Parent class. */
  i?: string;
  t: ClassKind;
  /** "editor" for editor-only classes (api_type). */
  a?: 'editor';
  /** Brief description (BBCode). */
  b: string;
  /** Full description (BBCode). */
  d: string;
  m: DocMember[];
  /** Project classes: the script's res:// path. */
  p?: string;
}

/** Bump when the on-disk index layout changes, so old caches are rebuilt. */
export const INDEX_FORMAT = 1;

export interface DocIndex {
  format: number;
  /** Godot version the index was built from ("4.7.2.stable.official.ed1daf0bf"). */
  version: string;
  classes: DocClass[];
}
