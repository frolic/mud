import { UserType } from "./types";

/**
 * The boundary conversions between a user type and the primitive it presents over.
 *
 * UDVTs use `wrap`/`unwrap`; enums use a value cast (`Direction(x)` / `uint8(x)`). Centralizing
 * the two spellings here keeps the field-wrapper renderer and the key codecs in lockstep — both
 * UDVTs and enums flow through one code path, branching only on `enumVariants`.
 */

/** Expression converting the wire primitive value to the presented user type. */
export function fromPrimitive(userType: UserType, inner: string): string {
  return userType.enumVariants ? `${userType.name}(${inner})` : `${userType.name}.wrap(${inner})`;
}

/** Expression converting a presented user-type value to its wire primitive. */
export function toPrimitive(userType: UserType, value: string): string {
  return userType.enumVariants ? `uint8(${value})` : `${userType.name}.unwrap(${value})`;
}
