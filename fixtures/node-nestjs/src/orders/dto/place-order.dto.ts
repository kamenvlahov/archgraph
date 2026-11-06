import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';

export class OrderItemInput {
  @IsString()
  sku!: string;

  @IsInt()
  quantity!: number;

  price!: number;
}

export class PlaceOrderDto {
  @IsInt()
  customerId!: number;

  @ValidateNested({ each: true })
  @Type(() => OrderItemInput)
  items!: OrderItemInput[];

  @IsOptional()
  @IsString()
  note?: string;
}
