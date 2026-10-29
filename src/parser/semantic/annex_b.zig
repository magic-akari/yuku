const std = @import("std");
const ast = @import("../ast.zig");
const binder = @import("binder.zig");
const sc = @import("scope.zig");

/// A sloppy block function that may also declare a var in its enclosing scope.
pub const Function = struct { node: ast.NodeIndex, scope: sc.ScopeId };

const none = std.math.maxInt(u32);

const ScopeFacts = struct {
    child: sc.ScopeId = .none,
    sibling: sc.ScopeId = .none,
    symbol: binder.SymbolId = .none,
    function: u32 = none,
};

const Name = struct { target: sc.ScopeId, text: []const u8 };

const NameContext = struct {
    pub fn hash(_: NameContext, name: Name) u64 {
        std.debug.assert(name.target != .none);
        std.debug.assert(name.text.len > 0);
        return std.hash.Wyhash.hash(@backingInt(name.target), name.text);
    }

    pub fn eql(_: NameContext, source: Name, target: Name) bool {
        std.debug.assert(source.target != .none);
        std.debug.assert(target.target != .none);
        return source.target == target.target and std.mem.eql(u8, source.text, target.text);
    }
};

/// Decides companion eligibility after every lexical declaration is known.
pub fn eligible(
    allocator: std.mem.Allocator,
    tree: *const ast.Tree,
    scopes: sc.ScopeTree,
    symbols: []const binder.Symbol,
    functions: []const Function,
) std.mem.Allocator.Error![]bool {
    std.debug.assert(functions.len > 0);
    std.debug.assert(scopes.list.len > 0);
    std.debug.assert(scopes.list.len <= std.math.maxInt(u32) / 2);
    const facts = try allocator.alloc(ScopeFacts, scopes.list.len);
    @memset(facts, .{});
    const next_symbols = try allocator.alloc(binder.SymbolId, symbols.len);
    const next_functions = try allocator.alloc(u32, functions.len);
    const result = try allocator.alloc(bool, functions.len);
    @memset(result, false);

    for (scopes.list, 0..) |scope, index| {
        if (scope.parent == .none) continue;
        std.debug.assert(@backingInt(scope.parent) < index);
        const parent = &facts[@backingInt(scope.parent)];
        facts[index].sibling = parent.child;
        parent.child = @fromBackingInt(@intCast(index));
    }
    for (symbols, 0..) |symbol, index| {
        if (!blocksCompanion(tree, scopes.get(symbol.scope), symbol.flags)) continue;
        const local = &facts[@backingInt(symbol.scope)];
        next_symbols[index] = local.symbol;
        local.symbol = @fromBackingInt(@intCast(index));
    }
    for (functions, 0..) |function, index| {
        const local = &facts[@backingInt(function.scope)];
        next_functions[index] = local.function;
        local.function = @intCast(index);
    }

    var blocked: std.HashMapUnmanaged(Name, u32, NameContext, 80) = .empty;
    try blocked.ensureTotalCapacity(allocator, @intCast(symbols.len));
    var current: sc.ScopeId = .root;
    var enter = true;
    // each scope enters and exits once, with blockers isolated by var environment
    for (0..scopes.list.len * 2) |_| {
        const scope = scopes.get(current);
        const local = facts[@backingInt(current)];
        var symbol = local.symbol;
        for (0..symbols.len) |_| {
            if (symbol == .none) break;
            const key: Name = .{
                .target = scope.hoist_target,
                .text = tree.string(symbols[@backingInt(symbol)].name),
            };
            if (enter) {
                const entry = blocked.getOrPutAssumeCapacity(key);
                if (!entry.found_existing) entry.value_ptr.* = 0;
                entry.value_ptr.* += 1;
            } else {
                const count = blocked.getPtr(key).?;
                std.debug.assert(count.* > 0);
                count.* -= 1;
            }
            symbol = next_symbols[@backingInt(symbol)];
        }
        std.debug.assert(symbol == .none);

        if (enter) {
            var function = local.function;
            for (0..functions.len) |_| {
                if (function == none) break;
                const name = tree.data(functions[function].node).binding_identifier.name;
                const count = blocked.get(.{
                    .target = scope.hoist_target,
                    .text = tree.string(name),
                }).?;
                std.debug.assert(count > 0);
                // the block's own ordinary functions share one lexical binding
                result[function] = count == 1;
                function = next_functions[function];
            }
            std.debug.assert(function == none);
            if (local.child != .none) {
                current = local.child;
            } else {
                enter = false;
            }
        } else {
            if (current == .root) return result;
            if (local.sibling != .none) {
                current = local.sibling;
                enter = true;
            } else {
                current = scope.parent;
            }
        }
    }
    unreachable;
}

fn blocksCompanion(tree: *const ast.Tree, scope: sc.Scope, flags: binder.Symbol.Flags) bool {
    std.debug.assert(scope.node != .null);
    if (flags.catch_var) {
        const data = tree.data(scope.node);
        std.debug.assert(data == .catch_clause);
        const parameter = data.catch_clause.param;
        return parameter != .null and tree.data(parameter) != .binding_identifier;
    }
    if (flags.parameter) return true;
    if (flags.block_scoped_var or flags.class) return true;
    return flags.function and !scope.kind.isHoistTarget();
}
