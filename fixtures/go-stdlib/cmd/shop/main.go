package main

import (
	"log"
	"net/http"

	"shop/internal/httpapi"
	"shop/internal/order"
)

func main() {
	service := order.NewService(order.NewMemoryRepository())
	handler := httpapi.NewHandler(service)
	mux := http.NewServeMux()
	handler.Routes(mux)
	log.Fatal(http.ListenAndServe(":8080", mux))
}
