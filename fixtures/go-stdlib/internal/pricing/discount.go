package pricing

var rules = map[string]func(float64) float64{
	"VIP":   vip,
	"STAFF": staff,
}

func Discount(price float64, note string) float64 {
	if rule, ok := rules[note]; ok {
		return rule(price)
	}
	return price
}

func vip(price float64) float64 { return price * 0.9 }

func staff(price float64) float64 { return price * 0.5 }
