#!/usr/bin/env python3
"""
Fix effect definitions to add uniform: mappings to globals.

For each global that has a default value but no uniform mapping,
add uniform: "globalName" to ensure the value is passed to shaders.
"""

import os
import re
import sys
from pathlib import Path


def fix_definition_file(filepath: Path) -> bool:
    """
    Fix a definition.js file to add uniform mappings.
    Returns True if file was modified.
    """
    content = filepath.read_text()
    
    # Skip if no globals section
    if 'globals' not in content:
        return False
    
    # Already has uniform mappings - skip
    if '"uniform":' in content or 'uniform:' in content:
        return False
    
    # Pattern to match a global property definition
    # Matches: propertyName: { ... default: value ... }
    # We need to add uniform: "propertyName" after default
    
    modified = False
    lines = content.split('\n')
    new_lines = []
    
    in_globals = False
    current_global_name = None
    brace_depth = 0
    globals_brace_depth = 0
    
    i = 0
    while i < len(lines):
        line = lines[i]
        
        # Track if we're in globals section
        if re.search(r'^\s*globals\s*[=:]\s*\{', line):
            in_globals = True
            globals_brace_depth = line.count('{') - line.count('}')
            new_lines.append(line)
            i += 1
            continue
        
        if in_globals:
            # Track brace depth
            globals_brace_depth += line.count('{') - line.count('}')
            
            if globals_brace_depth <= 0:
                in_globals = False
                new_lines.append(line)
                i += 1
                continue
            
            # Look for start of a global property: "name": { or name: {
            global_match = re.match(r'^(\s*)["\'"]?(\w+)["\'"]?\s*:\s*\{', line)
            if global_match:
                indent = global_match.group(1)
                current_global_name = global_match.group(2)
                brace_depth = 1
                new_lines.append(line)
                i += 1
                
                # Process the global's content until we close the brace
                while i < len(lines) and brace_depth > 0:
                    inner_line = lines[i]
                    brace_depth += inner_line.count('{') - inner_line.count('}')
                    
                    # Check if this line has "default" and we're about to close
                    if 'default' in inner_line and current_global_name:
                        # Check if uniform already exists in remaining lines of this global
                        has_uniform = False
                        temp_depth = brace_depth
                        for j in range(i + 1, len(lines)):
                            temp_depth += lines[j].count('{') - lines[j].count('}')
                            if '"uniform"' in lines[j] or 'uniform:' in lines[j]:
                                has_uniform = True
                                break
                            if temp_depth <= 0:
                                break
                        
                        if not has_uniform:
                            # Add uniform after default line
                            # Detect indentation from current line
                            inner_indent = re.match(r'^(\s*)', inner_line).group(1)
                            
                            # Check if line ends with comma
                            stripped = inner_line.rstrip()
                            if not stripped.endswith(','):
                                inner_line = stripped + ','
                            
                            new_lines.append(inner_line)
                            new_lines.append(f'{inner_indent}uniform: "{current_global_name}",')
                            modified = True
                            i += 1
                            continue
                    
                    new_lines.append(inner_line)
                    i += 1
                
                current_global_name = None
                continue
        
        new_lines.append(line)
        i += 1
    
    if modified:
        filepath.write_text('\n'.join(new_lines))
    
    return modified


def main():
    effects_dir = Path(__file__).parent.parent / 'shaders' / 'effects'
    
    if not effects_dir.exists():
        print(f"Effects directory not found: {effects_dir}")
        sys.exit(1)
    
    fixed_count = 0
    checked_count = 0
    
    for definition_file in effects_dir.rglob('definition.js'):
        checked_count += 1
        if fix_definition_file(definition_file):
            print(f"Fixed: {definition_file.relative_to(effects_dir.parent.parent)}")
            fixed_count += 1
    
    print(f"\nChecked {checked_count} files, fixed {fixed_count} files")


if __name__ == '__main__':
    main()
