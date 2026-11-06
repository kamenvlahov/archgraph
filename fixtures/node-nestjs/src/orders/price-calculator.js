/**
 * Legacy pricing helper, plain JavaScript with JSDoc types.
 */
export class PriceCalculator {
  /**
   * @param {number} total
   * @param {string} [code]
   * @returns {number}
   */
  applyDiscount(total, code) {
    return code === 'VIP' ? roundPrice(total * 0.9) : total;
  }
}

export function roundPrice(value) {
  return Math.round(value * 100) / 100;
}
