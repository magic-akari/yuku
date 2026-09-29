// ESTree metadata for the decoder generators, one source so they agree

const std = @import("std");
const parser = @import("parser");
const ast = parser.ast;

pub const BINARY_OPS = [_][]const u8{
    "==", "!=",         "===", "!==", "<", "<=", ">", ">=", "+",  "-",
    "*",  "/",          "%",   "**",  "|", "^",  "&", "<<", ">>", ">>>",
    "in", "instanceof",
};
pub const LOGICAL_OPS = [_][]const u8{ "&&", "||", "??" };
pub const UNARY_OPS = [_][]const u8{ "-", "+", "!", "~", "typeof", "void", "delete" };
pub const UPDATE_OPS = [_][]const u8{ "++", "--" };
pub const ASSIGNMENT_OPS = [_][]const u8{
    "=",   "+=",   "-=", "*=", "/=", "%=",  "**=", "<<=",
    ">>=", ">>>=", "|=", "^=", "&=", "||=", "&&=", "??=",
};
pub const VAR_KINDS = [_][]const u8{ "var", "let", "const", "using", "await using" };
pub const PROPERTY_KINDS = [_][]const u8{ "init", "get", "set" };
pub const METHOD_KINDS = [_][]const u8{ "constructor", "method", "get", "set" };
pub const FUNCTION_TYPES = [_][]const u8{
    "FunctionDeclaration",
    "FunctionExpression",
    "TSDeclareFunction",
    "TSEmptyBodyFunctionExpression",
};
pub const CLASS_TYPES = [_][]const u8{ "ClassDeclaration", "ClassExpression" };
pub const SEVERITY = [_][]const u8{ "error", "warning", "hint", "info" };

// tables with non-string elements, which the decoder writes raw
pub const IMPORT_EXPORT_KINDS_RAW = [_][]const u8{ "\"value\"", "\"type\"" };
pub const ACCESSIBILITY_RAW = [_][]const u8{ "null", "\"public\"", "\"private\"", "\"protected\"" };
pub const TS_TYPE_OPERATORS_RAW = [_][]const u8{ "\"keyof\"", "\"unique\"", "\"readonly\"" };
pub const TS_METHOD_SIGNATURE_KINDS_RAW = [_][]const u8{ "\"method\"", "\"get\"", "\"set\"" };
pub const TS_MODULE_KINDS_RAW = [_][]const u8{ "\"namespace\"", "\"module\"" };
pub const TS_MAPPED_OPTIONAL_RAW = [_][]const u8{ "false", "true", "\"+\"", "\"-\"" };
pub const TS_MAPPED_READONLY_RAW = [_][]const u8{ "null", "true", "\"+\"", "\"-\"" };

pub fn enumTableName(comptime E: type) []const u8 {
    if (E == ast.BinaryOperator) return "BINARY_OPS";
    if (E == ast.LogicalOperator) return "LOGICAL_OPS";
    if (E == ast.UnaryOperator) return "UNARY_OPS";
    if (E == ast.UpdateOperator) return "UPDATE_OPS";
    if (E == ast.AssignmentOperator) return "ASSIGNMENT_OPS";
    if (E == ast.VariableKind) return "VAR_KINDS";
    if (E == ast.PropertyKind) return "PROPERTY_KINDS";
    if (E == ast.MethodDefinitionKind) return "METHOD_KINDS";
    if (E == ast.FunctionType) return "FUNCTION_TYPES";
    if (E == ast.ClassType) return "CLASS_TYPES";
    if (E == ast.ImportOrExportKind) return "IMPORT_EXPORT_KINDS";
    if (E == ast.Accessibility) return "ACCESSIBILITY";
    if (E == ast.TSTypeOperatorKind) return "TS_TYPE_OPERATORS";
    if (E == ast.TSMethodSignatureKind) return "TS_METHOD_SIGNATURE_KINDS";
    if (E == ast.TSModuleDeclarationKind) return "TS_MODULE_KINDS";
    @compileError("no lookup table for enum: " ++ @typeName(E));
}

// ESTree name overrides where snake to pascal is wrong (ts_jsdoc_ to TSJSDoc)
const NAME_OVERRIDES = [_]struct { z: []const u8, e: []const u8 }{
    .{ .z = "function_body", .e = "BlockStatement" },
    .{ .z = "binding_rest_element", .e = "RestElement" },
    .{ .z = "object_property", .e = "Property" },
    .{ .z = "identifier_reference", .e = "Identifier" },
    .{ .z = "binding_identifier", .e = "Identifier" },
    .{ .z = "identifier_name", .e = "Identifier" },
    .{ .z = "label_identifier", .e = "Identifier" },
    .{ .z = "ts_bigint_keyword", .e = "TSBigIntKeyword" },
    .{ .z = "ts_jsdoc_nullable_type", .e = "TSJSDocNullableType" },
    .{ .z = "ts_jsdoc_non_nullable_type", .e = "TSJSDocNonNullableType" },
    .{ .z = "ts_jsdoc_unknown_type", .e = "TSJSDocUnknownType" },
};

pub fn estreeType(comptime name: []const u8) []const u8 {
    inline for (NAME_OVERRIDES) |o| if (comptime std.mem.eql(u8, name, o.z)) return o.e;
    if (comptime std.mem.startsWith(u8, name, "jsx_")) {
        return "JSX" ++ snakeConvert(name[4..], true);
    }
    if (comptime std.mem.startsWith(u8, name, "ts_")) return "TS" ++ snakeConvert(name[3..], true);
    return snakeConvert(name, true);
}

pub fn estreeField(comptime tag: []const u8, comptime field: []const u8) []const u8 {
    if (comptime std.mem.eql(u8, tag, "variable_declaration") and
        std.mem.eql(u8, field, "declarators")) return "declarations";
    // const is a zig keyword so the field is is_const, ESTree renders it as const
    if (comptime std.mem.eql(u8, tag, "ts_enum_declaration") and
        std.mem.eql(u8, field, "is_const")) return "const";
    return snakeConvert(field, false);
}

// arrays that allow holes, sparse elements become null in ESTree
pub fn isHoleyArray(comptime tag: []const u8, comptime field: []const u8) bool {
    return std.mem.eql(u8, tag, "array_expression") and std.mem.eql(u8, field, "elements");
}

pub fn snakeConvert(comptime name: []const u8, comptime pascal: bool) []const u8 {
    comptime {
        @setEvalBranchQuota(200_000);
        var result: [name.len]u8 = undefined;
        var len: usize = 0;
        var cap = pascal;
        for (name) |c| {
            if (c == '_') {
                cap = true;
            } else {
                result[len] = if (cap) std.ascii.toUpper(c) else c;
                cap = false;
                len += 1;
            }
        }
        const final = result[0..len].*;
        return &final;
    }
}
