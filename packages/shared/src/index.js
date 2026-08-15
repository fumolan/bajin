import { z } from 'zod';
export const PERMISSION_MODES = ['plan', 'build', 'edit', 'yolo'];
/** 把 zod schema 转成 provider 需要的 JSON Schema */
export function toolSchemaToParameters(schema) {
    return z.toJSONSchema(schema);
}
//# sourceMappingURL=index.js.map