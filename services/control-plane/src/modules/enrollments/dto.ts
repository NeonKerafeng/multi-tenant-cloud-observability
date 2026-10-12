import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/** FROZEN body of client/bootstrap.sh: `{"token": "..."}`. */
export class ExchangeDto {
  @ApiProperty({ description: 'The enrollmentToken given by the tenant admin' })
  @IsString()
  @Length(1, 200)
  token!: string;
}
