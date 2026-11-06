import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { PlaceOrderDto } from './dto/place-order.dto';
import type { OrderView } from './dto/order-view';
import type { Order } from './entities/order.entity';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  async place(@Body() dto: PlaceOrderDto): Promise<OrderView> {
    return this.toView(await this.orders.place(dto));
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number): Promise<OrderView> {
    return this.toView(await this.orders.get(id));
  }

  private toView(order: Order): OrderView {
    return { id: order.getId() ?? 0, total: order.total(), items: order.items.length };
  }
}
