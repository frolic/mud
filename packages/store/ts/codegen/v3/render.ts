/**
 * The one and only rendering primitive.
 *
 * `code` is a tagged template for assembling Solidity source. Its only magic:
 * an interpolated array is flattened and joined with newlines, and `undefined`
 * / `false` / `""` interpolations disappear. That lets you drop
 * `fields.map(renderField)` straight into a template like JSX children, and
 * conditionally include a line with `cond && code\`...\`` — without any helper
 * functions or string juggling.
 *
 * Deliberately NOT handled here: indentation and line wrapping. The final
 * output is run through prettier-plugin-solidity (see `format`), so templates
 * are written purely for readability, never for layout. Read a template and
 * you read the output.
 */
export function code(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, str, i) => acc + str + render(values[i]), "");
}

function render(value: unknown): string {
  if (value == null || value === false) return "";
  if (Array.isArray(value)) return value.map(render).join("\n");
  return String(value);
}
