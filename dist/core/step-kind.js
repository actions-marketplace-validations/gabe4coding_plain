import { z } from 'zod';
const StepKindSchema = z.enum([
    'goto', 'fill', 'click', 'hover', 'dblclick', 'rightclick', 'select', 'check',
    'uncheck', 'upload', 'scroll', 'wait', 'press', 'drag', 'mouse', 'expect',
]);
export const StepKind = StepKindSchema.enum;
