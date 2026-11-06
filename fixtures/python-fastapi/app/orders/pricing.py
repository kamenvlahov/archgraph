def apply_discount(total, code=None):
    """Legacy helper without type hints."""
    if code == "VIP":
        return round(total * 0.9, 2)
    return total
