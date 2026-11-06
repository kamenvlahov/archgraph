import type { Order } from './entities/order.entity';

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');

export interface OrderRepository {
  find(id: number): Promise<Order | null>;
  save(order: Order): Promise<void>;
}
