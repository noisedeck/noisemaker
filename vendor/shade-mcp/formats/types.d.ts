export interface EffectUniform {
    name: string;
    type: 'float' | 'int' | 'vec2' | 'vec3' | 'vec4' | 'boolean';
    uniform: string;
    default?: number | number[];
    min?: number;
    max?: number;
    step?: number;
    choices?: Record<string, number>;
    control?: boolean;
}
export interface EffectPass {
    name?: string;
    program: string;
    type?: 'render' | 'compute' | 'gpgpu';
    inputs?: Record<string, string>;
    outputs?: Record<string, string>;
}
export interface EffectDefinition {
    func: string;
    name?: string;
    namespace?: string;
    description?: string;
    starter?: boolean;
    tags?: string[];
    globals: Record<string, EffectUniform>;
    passes: EffectPass[];
    format: 'json' | 'js';
    effectDir: string;
}
//# sourceMappingURL=types.d.ts.map