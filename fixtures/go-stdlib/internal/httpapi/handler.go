package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"

	"shop/internal/order"
)

type OrderOut struct {
	ID    int     `json:"id"`
	Total float64 `json:"total"`
	Items int     `json:"items"`
}

type Handler struct {
	orders *order.Service
}

func NewHandler(orders *order.Service) *Handler {
	return &Handler{orders: orders}
}

func (h *Handler) Routes(mux *http.ServeMux) {
	mux.HandleFunc("POST /orders", h.Place)
	mux.HandleFunc("GET /orders/{id}", h.Get)
}

func (h *Handler) Place(w http.ResponseWriter, r *http.Request) {
	var in order.PlaceInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	o, err := h.orders.Place(r.Context(), in)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, toOut(o))
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("id"))
	o, err := h.orders.Get(r.Context(), id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(w, toOut(o))
}

func toOut(o *order.Order) OrderOut {
	return OrderOut{ID: o.GetID(), Total: o.Total(), Items: len(o.Items)}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
