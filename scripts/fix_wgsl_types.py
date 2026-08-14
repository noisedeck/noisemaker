#!/usr/bin/env python3
"""Add explicit type annotations to WGSL let bindings."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

WGSL_ROOT = Path('js/noisemaker/webgpu/shaders')


@dataclass
class TypeEnv:
    scopes: List[Dict[str, str]]
    structs: Dict[str, Dict[str, str]]
    function_returns: Dict[str, str]

    def __init__(self, structs: Dict[str, Dict[str, str]], function_returns: Dict[str, str]) -> None:
        self.structs = structs
        self.function_returns = function_returns
        self.scopes = [dict()]

    def push(self) -> None:
        self.scopes.append(dict())

    def pop(self) -> None:
        if len(self.scopes) > 1:
            self.scopes.pop()

    def set(self, name: str, value: str) -> None:
        self.scopes[-1][name] = value

    def get(self, name: str) -> Optional[str]:
        for scope in reversed(self.scopes):
            if name in scope:
                return scope[name]
        return None

    def resolve_member(self, base: str, member: str) -> Optional[str]:
        base_type = self.get(base)
        if base_type is None:
            return None
        if base_type.startswith('vec'):
            scalar = base_type[base_type.find('<') + 1 : base_type.rfind('>')]
            if member and all(ch in 'xyzwrgba' for ch in member):
                if len(member) == 1:
                    return scalar
                return f"vec{len(member)}<{scalar}>"
        if base_type.startswith('mat'):
            return 'f32'
        field_map = self.structs.get(base_type)
        if field_map:
            field_type = field_map.get(member)
            if field_type:
                return field_type
        return None


FUNC_PARAM_RE = re.compile(
    r"fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((?P<params>[^)]*)\)\s*(?:->\s*([^\s{]+))?",
    re.DOTALL,
)
PARAM_RE = re.compile(
    r"(?:(?:@[A-Za-z_][A-Za-z0-9_]*\([^)]*\)|@[A-Za-z_][A-Za-z0-9_]*)\s*)*"
    r"([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,]+)"
)
STRUCT_RE = re.compile(r"struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\};", re.DOTALL)
STRUCT_FIELD_RE = re.compile(
    r"(?:(?:@[A-Za-z_][A-Za-z0-9_]*\([^)]*\)|@[A-Za-z_][A-Za-z0-9_]*)\s*)*"
    r"([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,;]+)"
)
LET_ASSIGN_RE = re.compile(r"^(\s*)let\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+);\s*$")
LET_TYPED_RE = re.compile(r"^(\s*)let\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*")
VAR_DECL_RE = re.compile(r"^(\s*)var(?:<[^>]+>)?\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^=;]+)")
VAR_ASSIGN_RE = re.compile(r"^(\s*)var\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+);\s*$")
GROUP_VAR_RE = re.compile(r"var\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^;]+);")


def parse_structs(text: str) -> Dict[str, Dict[str, str]]:
    structs: Dict[str, Dict[str, str]] = {}
    for match in STRUCT_RE.finditer(text):
        name = match.group(1)
        body = match.group(2)
        fields: Dict[str, str] = {}
        for field in STRUCT_FIELD_RE.finditer(body):
            field_name = field.group(1)
            field_type = field.group(2).strip()
            fields[field_name] = field_type
        structs[name] = fields
    return structs


def parse_function_params(text: str) -> Tuple[Dict[int, Dict[str, str]], Dict[str, str]]:
    param_map: Dict[int, Dict[str, str]] = {}
    return_map: Dict[str, str] = {}
    for match in FUNC_PARAM_RE.finditer(text):
        start = match.start()
        params = match.group('params')
        func_name = match.group(1)
        return_type = match.group(3)
        if return_type:
            return_map[func_name] = return_type.strip()
        param_dict: Dict[str, str] = {}
        for param_match in PARAM_RE.finditer(params):
            name = param_match.group(1)
            type_expr = param_match.group(2).strip()
            param_dict[name] = type_expr
        param_map[start] = param_dict
    return param_map, return_map


def is_float_literal(token: str) -> bool:
    return bool(re.match(r"[-+]?[0-9]*\.[0-9]+(?:[eE][-+]?[0-9]+)?f?", token))


def is_uint_literal(token: str) -> bool:
    return bool(re.match(r"[-+]?[0-9]+u", token))


def is_int_literal(token: str) -> bool:
    return bool(re.match(r"[-+]?[0-9]+", token)) and not is_uint_literal(token)


def guess_literal_type(token: str) -> Optional[str]:
    token = token.strip()
    if is_uint_literal(token):
        return 'u32'
    if is_float_literal(token):
        return 'f32'
    if token in {'true', 'false'}:
        return 'bool'
    if is_int_literal(token):
        return 'i32'
    return None


def guess_type_from_call(name: str, args: List[str], env: TypeEnv) -> Optional[str]:
    if name in {'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'exp', 'exp2', 'log', 'log2', 'sqrt', 'rsqrt', 'pow', 'floor', 'ceil', 'fract', 'abs', 'sign', 'normalize', 'inverseSqrt', 'trunc', 'round'}:
        arg_type = infer_type(args[0], env)
        return arg_type or 'f32'
    if name in {'min', 'max', 'clamp', 'select', 'mix', 'lerp'}:
        arg_type = infer_type(args[0], env)
        return arg_type
    if name in {'dot', 'distance', 'length'}:
        return 'f32'
    if name in {'any', 'all'}:
        return 'bool'
    if name.startswith('textureSampleCompare'):
        return 'f32'
    if name.startswith('textureSample') or name.startswith('textureGather'):
        return 'vec4<f32>'
    if name.startswith('textureLoad'):
        if args:
            base_expr = args[0].strip()
            base_name = re.split(r"[^A-Za-z0-9_]", base_expr)[0]
            base_type = env.get(base_name)
            if base_type and '<' in base_type and 'texture' in base_type:
                subtype = 'f32'
                if '<' in base_type:
                    inner = base_type[base_type.find('<') + 1 : base_type.rfind('>')]
                    if ',' in inner:
                        subtype = inner.split(',')[0].strip()
                    else:
                        subtype = inner.strip()
                return f'vec4<{subtype}>'
        return 'vec4<f32>'
    if name.startswith('textureDimensions'):
        return 'vec2<u32>'
    if name.startswith('textureNumLevels') or name.startswith('textureNumLayers'):
        return 'u32'
    return None


def split_args(arg_str: str) -> List[str]:
    args: List[str] = []
    depth = 0
    current = []
    for ch in arg_str:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth = max(0, depth - 1)
        elif ch == ',' and depth == 0:
            args.append(''.join(current).strip())
            current = []
            continue
        current.append(ch)
    tail = ''.join(current).strip()
    if tail:
        args.append(tail)
    return args


def infer_type(expr: str, env: TypeEnv) -> Optional[str]:
    expr = expr.strip()
    if not expr:
        return None
    # Parentheses wrapping
    while expr.startswith('(') and expr.endswith(')'):
        inner = expr[1:-1].strip()
        if inner.count('(') == inner.count(')'):
            expr = inner
        else:
            break

    literal_type = guess_literal_type(expr)
    if literal_type:
        return literal_type

    cast_match = re.match(r'(?:f16|f32|i32|u32|bool)\s*\((.*)\)', expr)
    if cast_match:
        return expr.split('(')[0].strip()

    if expr.startswith('vec') and '<' in expr:
        vec_match = re.match(r'(vec[234])<([^>]+)>\s*\(', expr)
        if vec_match:
            return f"{vec_match.group(1)}<{vec_match.group(2).strip()}>"

    if expr.startswith('mat') and '<' in expr:
        mat_match = re.match(r'(mat[234]x?[234]?)<([^>]+)>\s*\(', expr)
        if mat_match:
            return f"{mat_match.group(1)}<{mat_match.group(2).strip()}>"

    swizzle_match = re.match(r'(.+)\.([A-Za-z]{1,4})$', expr)
    if swizzle_match:
        base_expr = swizzle_match.group(1).strip()
        member = swizzle_match.group(2)
        if member and all(ch in 'xyzwrgba' for ch in member):
            base_type = infer_type(base_expr, env)
            if base_type and base_type.startswith('vec') and '<' in base_type:
                scalar = base_type[base_type.find('<') + 1 : base_type.rfind('>')]
                if len(member) == 1:
                    return scalar
                return f"vec{len(member)}<{scalar}>"

    member_match = re.match(r'([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$', expr)
    if member_match:
        base = member_match.group(1)
        member = member_match.group(2)
        resolved = env.resolve_member(base, member)
        if resolved:
            return resolved

    env_type = env.get(expr)
    if env_type:
        return env_type

    if '(' not in expr and ')' not in expr:
        token_types = set()
        for token in re.findall(r'[A-Za-z_][A-Za-z0-9_]*', expr):
            resolved = env.get(token)
            if resolved in {'f32', 'i32', 'u32', 'bool'}:
                token_types.add(resolved)
            else:
                literal_guess = guess_literal_type(token)
                if literal_guess in {'f32', 'i32', 'u32', 'bool'}:
                    token_types.add(literal_guess)
        if len(token_types) == 1:
            return token_types.pop()

    call_match = re.match(r'([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)', expr, re.DOTALL)
    if call_match:
        func = call_match.group(1)
        args = split_args(call_match.group(2))
        guessed = guess_type_from_call(func, args, env)
        if guessed:
            return guessed
        if func in env.function_returns:
            return env.function_returns[func]
        arg_types = [infer_type(arg, env) for arg in args if arg]
        for arg_type in arg_types:
            if arg_type:
                return arg_type

    if any(op in expr for op in [' && ', ' || ', ' == ', ' != ', ' >= ', ' <= ', ' > ', ' < ']):
        return 'bool'

    if any(token.endswith('u') for token in re.findall(r'[A-Za-z0-9_]+', expr)):
        return 'u32'

    if re.search(r'\b(i32|u32)\b', expr):
        if 'u32' in expr:
            return 'u32'
        return 'i32'

    if re.search(r'[0-9]+\.[0-9]', expr):
        return 'f32'

    return 'f32'


def annotate_file(path: Path) -> None:
    text = path.read_text()
    structs = parse_structs(text)
    func_params, function_returns = parse_function_params(text)
    env = TypeEnv(structs, function_returns)
    new_lines: List[str] = []
    func_positions = sorted(func_params.keys())
    func_iter = iter(func_positions)
    next_func = next(func_iter, None)

    offset = 0
    lines = text.splitlines()
    line_index = 0
    while line_index < len(lines):
        line = lines[line_index]
        pos = offset
        offset += len(line) + 1
        stripped = line.strip()

        if next_func is not None and pos >= next_func:
            params = func_params[next_func]
            env.push()
            for name, type_expr in params.items():
                env.set(name, type_expr)
            next_func = next(func_iter, None)

        var_decl = VAR_DECL_RE.match(line)
        if var_decl:
            name = var_decl.group(2)
            type_expr = var_decl.group(3).strip()
            env.set(name, type_expr)
            new_lines.append(line)
            line_index += 1
            continue

        group_decl = GROUP_VAR_RE.search(line)
        if group_decl:
            env.set(group_decl.group(1), group_decl.group(2).strip())

        if LET_TYPED_RE.match(line) or stripped.startswith('const '):
            assign_match = re.match(r".*let\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^=]+)=", line)
            if assign_match:
                env.set(assign_match.group(1), assign_match.group(2).strip())
            new_lines.append(line)
            line_index += 1
            continue

        let_match = LET_ASSIGN_RE.match(line)
        if let_match:
            indent, name, expr = let_match.groups()
            inferred = infer_type(expr, env)
            if inferred is None:
                inferred = 'f32'
            env.set(name, inferred)
            new_line = f"{indent}let {name} : {inferred} = {expr};"
            new_lines.append(new_line)
            line_index += 1
            continue

        var_assign = VAR_ASSIGN_RE.match(line)
        if var_assign:
            indent, name, expr = var_assign.groups()
            inferred = infer_type(expr, env)
            if inferred is None:
                inferred = 'f32'
            env.set(name, inferred)
            new_lines.append(f"{indent}var {name} : {inferred} = {expr};")
            line_index += 1
            continue

        if stripped.startswith('let ') and '=' in stripped and not stripped.endswith(';'):
            buffer = [line.strip('\n')]
            combined = line
            depth = combined.count('(') - combined.count(')')
            temp_index = line_index + 1
            temp_offset = offset
            while temp_index < len(lines):
                next_line = lines[temp_index]
                combined += '\n' + next_line
                depth += next_line.count('(') - next_line.count(')')
                buffer.append(next_line.strip('\n'))
                temp_offset += len(next_line) + 1
                if ';' in next_line:
                    break
                temp_index += 1
            match = re.match(r"(\s*)let\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*);", combined, re.DOTALL)
            if match:
                indent, name, expr = match.groups()
                inferred = infer_type(expr, env)
                if inferred is None:
                    inferred = 'f32'
                env.set(name, inferred)
                new_lines.append(f"{indent}let {name} : {inferred} = {expr};")
                offset = temp_offset
                line_index = temp_index + 1
                continue

        if stripped.startswith('var ') and '=' in stripped and not stripped.endswith(';'):
            buffer = [line.strip('\n')]
            combined = line
            temp_index = line_index + 1
            temp_offset = offset
            while temp_index < len(lines):
                next_line = lines[temp_index]
                combined += '\n' + next_line
                temp_offset += len(next_line) + 1
                buffer.append(next_line.strip('\n'))
                if ';' in next_line:
                    break
                temp_index += 1
            match = re.match(r"(\s*)var\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*);", combined, re.DOTALL)
            if match:
                indent, name, expr = match.groups()
                inferred = infer_type(expr, env)
                if inferred is None:
                    inferred = 'f32'
                env.set(name, inferred)
                new_lines.append(f"{indent}var {name} : {inferred} = {expr};")
                offset = temp_offset
                line_index = temp_index + 1
                continue

        if stripped == '}':
            if len(env.scopes) > 1:
                env.pop()
        new_lines.append(line)
        line_index += 1

    path.write_text('\n'.join(new_lines) + '\n')


def main() -> None:
    for file_path in sorted(WGSL_ROOT.rglob('*.wgsl')):
        annotate_file(file_path)


if __name__ == '__main__':
    main()
