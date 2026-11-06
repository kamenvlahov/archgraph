import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PlaceOrderDto } from './dto/place-order.dto';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { ORDER_REPOSITORY, type OrderRepository } from './order.repository';
import { PriceCalculator } from './price-calculator.js';

@Injectable()
export class OrdersService {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    private readonly prices: PriceCalculator,
  ) {}

  async place(dto: PlaceOrderDto): Promise<Order> {
    const order = Order.create(dto.customerId);
    for (const item of dto.items) {
      order.addItem(OrderItem.of(item.sku, item.quantity, this.prices.applyDiscount(item.price, dto.note)));
    }
    await this.orders.save(order);
    return order;
  }

  async get(id: number): Promise<Order> {
    const order = await this.orders.find(id);
    if (!order) {
      throw new NotFoundException(`Order ${id} not found`);
    }
    return order;
  }
}
