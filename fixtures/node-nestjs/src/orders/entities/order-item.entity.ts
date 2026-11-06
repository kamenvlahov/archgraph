import { Column, Entity } from 'typeorm';
import { AbstractEntity } from './abstract.entity';

@Entity()
export class OrderItem extends AbstractEntity {
  @Column()
  sku!: string;

  @Column()
  quantity!: number;

  @Column('decimal')
  price!: number;

  subtotal(): number {
    return this.quantity * this.price;
  }

  static of(sku: string, quantity: number, price: number): OrderItem {
    const item = new OrderItem();
    Object.assign(item, { sku, quantity, price });
    return item;
  }
}
