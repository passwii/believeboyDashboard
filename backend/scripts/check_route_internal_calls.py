from __future__ import annotations

import ast
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / 'app' / 'api' / 'v1' / 'endpoints'


def is_router_decorator(node: ast.expr) -> bool:
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    return isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id == 'router'


def main() -> int:
    findings: list[tuple[Path, int, str, str]] = []

    for path in sorted(ROOT.glob('*.py')):
        try:
            source = path.read_text(encoding='utf-8')
            tree = ast.parse(source, filename=str(path))
        except SyntaxError as exc:
            print(f'SYNTAX_ERROR {path}: {exc}', file=sys.stderr)
            return 2

        route_functions: set[str] = set()
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and any(is_router_decorator(decorator) for decorator in node.decorator_list):
                route_functions.add(node.name)

        class Visitor(ast.NodeVisitor):
            def __init__(self) -> None:
                self.current: str | None = None

            def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
                previous = self.current
                self.current = node.name
                self.generic_visit(node)
                self.current = previous

            def visit_Call(self, node: ast.Call) -> None:
                if self.current and isinstance(node.func, ast.Name):
                    callee = node.func.id
                    if callee in route_functions and callee != self.current:
                        findings.append((path, node.lineno, self.current, callee))
                self.generic_visit(node)

        Visitor().visit(tree)

    if findings:
        print('Route-to-route internal calls detected:', file=sys.stderr)
        for path, lineno, current, callee in findings:
            print(f'  {path}:{lineno} {current} -> {callee}', file=sys.stderr)
        return 1

    print('No route-to-route internal calls detected.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
