'use strict';
function meanPixelDifference(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let total = 0;
  for (let index = 0; index < a.length; index++) total += Math.abs(a[index] - b[index]);
  return total / a.length;
}
module.exports = { meanPixelDifference };
