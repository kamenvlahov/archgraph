package order

import "testing"

type fakeRepository struct{}

func (fakeRepository) Find(id int) (*Order, error) { return &Order{}, nil }
func (fakeRepository) Save(o *Order) error         { return nil }

func TestGet(t *testing.T) {
	if _, err := NewService(fakeRepository{}).Get(nil, 1); err != nil {
		t.Fatal(err)
	}
}
