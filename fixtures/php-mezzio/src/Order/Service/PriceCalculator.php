<?php

declare(strict_types=1);

namespace App\Order\Service;

class PriceCalculator
{
    /**
     * Legacy code without types.
     */
    public function applyDiscount($total, $code = null)
    {
        if ($code === 'VIP') {
            return $total * 0.9;
        }

        return $total;
    }
}
