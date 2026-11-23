package pricing

import "strings"

func Discount(price float64, note string) float64 {
	if strings.Contains(note, "VIP") {
		return price * 0.9
	}
	return price
}
