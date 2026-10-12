import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * PATCH body shared by resources that can be switched off (users, agents).
 * Each resource extends it so its own fields can be added later.
 */
export class EnabledPatchDto {
  @ApiPropertyOptional({
    description: 'false = disable (blocked at once), true = enable again',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
