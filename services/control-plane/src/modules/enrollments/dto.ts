import { IsString, Length } from 'class-validator';

export class ExchangeDto {
  @IsString()
  @Length(1, 200)
  token!: string;
}
