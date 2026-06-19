// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

import { EncodedLengths } from "../EncodedLengths.sol";

/**
 * @notice Computes the byte range of one dynamic field inside a record's packed
 *         dynamic data, from the record's encoded lengths.
 * @dev Used by every dynamic field lib's `decode` to slice its own bytes out of
 *      the whole-record dynamic blob.
 */
library DynamicRange {
  function range(EncodedLengths encodedLengths, uint8 index) internal pure returns (uint256 start, uint256 end) {
    unchecked {
      for (uint8 i; i < index; i++) {
        start += encodedLengths.atIndex(i);
      }
      end = start + encodedLengths.atIndex(index);
    }
  }
}
