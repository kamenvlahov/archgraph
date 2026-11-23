package order

func (o *Order) AddItem(item Item) {
	o.Items = append(o.Items, item)
}

func (o *Order) Total() float64 {
	total := 0.0
	for _, item := range o.Items {
		total += item.Subtotal()
	}
	return total
}

type Summary struct {
	Items int
	Total float64
}

func NewSummary(o *Order) *Summary {
	return &Summary{Items: len(o.Items), Total: o.Total()}
}
