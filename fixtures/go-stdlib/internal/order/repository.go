package order

import "errors"

var ErrNotFound = errors.New("order not found")

type Repository interface {
	Find(id int) (*Order, error)
	Save(o *Order) error
}

type MemoryRepository struct {
	orders map[int]*Order
}

func NewMemoryRepository() *MemoryRepository {
	return &MemoryRepository{orders: map[int]*Order{}}
}

func (r *MemoryRepository) Find(id int) (*Order, error) {
	o, ok := r.orders[id]
	if !ok {
		return nil, ErrNotFound
	}
	return o, nil
}

func (r *MemoryRepository) Save(o *Order) error {
	if o.ID == 0 {
		o.ID = len(r.orders) + 1
	}
	r.orders[o.ID] = o
	return nil
}
