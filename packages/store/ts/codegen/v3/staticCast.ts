/**
 * The one place that knows how to cast a packed `bytesN` value to its Solidity value type.
 *
 * Shared by the field-library generator (`generateFields`) and the inlined record codec
 * (`renderTable`'s `renderCodec`) so the per-type cast logic is single-sourced — the codec
 * inlines exactly what the field lib's `decode` would have done, never a second spelling.
 */

/** Cast a `bytesN`-valued expression to the Solidity value type `abiType`. */
export function cast(abiType: string, bytesN: string): string {
  if (abiType === "bool") return `uint8(${bytesN}) != 0`;
  if (abiType === "address") return `address(uint160(${bytesN}))`;
  if (/^bytes\d+$/.test(abiType)) return bytesN;
  const uintBits = abiType.match(/^uint(\d+)$/)?.[1];
  if (uintBits) return `uint${uintBits}(${bytesN})`;
  const intBits = abiType.match(/^int(\d+)$/)?.[1];
  if (intBits) return `int${intBits}(uint${intBits}(${bytesN}))`;
  throw new Error(`No cast for ${abiType}`);
}
