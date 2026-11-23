package order

type BaseEntity struct {
	ID int
}

func (e *BaseEntity) GetID() int {
	return e.ID
}

type Item struct {
	BaseEntity
	SKU      string
	Quantity int
	Price    float64
}

func (i Item) Subtotal() float64 {
	return float64(i.Quantity) * i.Price
}

type Order struct {
	BaseEntity
	CustomerID int
	Status     string
	Items      []Item
}
