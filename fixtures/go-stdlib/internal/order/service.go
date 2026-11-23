package order

import (
	"context"

	"shop/internal/pricing"
)

type (
	PlaceInput struct {
		CustomerID int
		Note       string
		Items      []ItemInput
	}

	ItemInput struct {
		SKU      string
		Quantity int
		Price    float64
	}
)

type Service struct {
	repo Repository
}

func NewService(repo Repository) *Service {
	return &Service{repo: repo}
}

func (s *Service) Place(ctx context.Context, in PlaceInput) (*Order, error) {
	o := &Order{CustomerID: in.CustomerID, Status: "new"}
	for _, it := range in.Items {
		o.AddItem(Item{SKU: it.SKU, Quantity: it.Quantity, Price: pricing.Discount(it.Price, in.Note)})
	}
	if err := s.repo.Save(o); err != nil {
		return nil, err
	}
	return o, nil
}

func (s *Service) Get(ctx context.Context, id int) (*Order, error) {
	return s.repo.Find(id)
}
