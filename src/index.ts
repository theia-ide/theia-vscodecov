#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import * as jsonc from "jsonc-parser";
import * as yargs from "yargs";

const argv = yargs
    .option("package", {
        alias: "e",
        default: process.cwd(),
        description: "package path"
    })
    .option("main", {
        alias: "m",
        default: "src/extension.ts",
        description: "a package relative entry module path"
    })
    .option("config", {
        alias: "c",
        default: "tsconfig.json",
        description: "a package relative tsconfig path"
    })
    .help().argv;

if (!fs.existsSync(argv.package)) {
    console.error(
        `"${
        argv.package
        }" package path should exist, use "package" option to specify a package path`
    );
    process.exit(1);
}
const rootPath = path.join(argv.package, argv.main);
if (!fs.existsSync(rootPath)) {
    console.error(
        `"${rootPath}" package entry module path should exist, use "main" option to specify a package relative path`
    );
    process.exit(1);
}
const tsconfigPath = path.join(argv.package, argv.config);
if (!fs.existsSync(tsconfigPath)) {
    console.error(
        `"${tsconfigPath}" tsconfig path should exist, use "config" option to specify a package relative path`
    );
    process.exit(1);
}

const theiaFileName = require.resolve("@theia/plugin/src/theia.d.ts");
const theiaProgram = ts.createProgram({
    rootNames: [theiaFileName],
    options: {}
});
const theiaFile = theiaProgram.getSourceFile(theiaFileName)!;
const theiaTypeChecker = theiaProgram.getTypeChecker();
const theiaSymbols = new Set<string>();
const visitTheia = (node: ts.Node) => {
    try {
        const type = theiaTypeChecker.getTypeAtLocation(node);
        const symbol = type.getSymbol();
        if (symbol) {
            const qualifiedName = theiaTypeChecker.getFullyQualifiedName(symbol);
            if (
                qualifiedName.startsWith('"@theia/plugin".') &&
                !theiaSymbols.has(qualifiedName)
            ) {
                theiaSymbols.add(qualifiedName);
            }
        }
    } catch {
        /* no-op */
    }
    ts.forEachChild(node, visitTheia);
};
theiaFile.forEachChild(visitTheia);

const theiaCommands = new Set<string>([
    "vscode.open",
    "vscode.diff",
    "setContext",
    "vscode.previewHtml"
]);

const tsconfig = fs.readFileSync(tsconfigPath, "utf-8");
const options = jsonc.parse(tsconfig, undefined, {
    disallowComments: false,
    allowTrailingComma: true
});

const program = ts.createProgram({
    rootNames: [rootPath],
    options
});
const commands = new Set<string>();
const dynamicCommanCalls = new Set<string>();
const missingCommands = new Set<string>();
const symbols = new Set<string>();
const missingSymbols = new Set<string>();
const typeChecker = program.getTypeChecker();

const getStringValue: (node: ts.Node) => string | undefined = node => {
    if (ts.isStringLiteralLike(node)) {
        const text = node.getText();
        return text.substr(1, text.length - 2);
    }
}

const getCommand: (expression: ts.Expression) => string | undefined = expression => {
    const value = getStringValue(expression)
    if (value) {
        return value;
    }
    const type = typeChecker.getTypeAtLocation(expression);
    if (type && type.isStringLiteral()) {
        return type.value;
    }
}

const pushCommand = (command: string) => {
    if (theiaCommands.has(command)) {
        commands.add(command);
    } else {
        missingCommands.add(command);
    }
}

const visit = (node: ts.Node) => {
    try {
        const value = getStringValue(node);
        if (value) {
            for (const prefix of ['vscode.', 'workbench.', 'editor.', 'history.', 'search.', 'markdown.', 'actions.']) {
                if (value.startsWith(prefix)) {
                    pushCommand(value);
                }
            }
        }
        const type = typeChecker.getTypeAtLocation(node);
        const symbol = type.getSymbol();
        if (symbol) {
            const qualifiedName = typeChecker.getFullyQualifiedName(symbol);
            if (qualifiedName.startsWith('"vscode".')) {
                if (
                    qualifiedName.endsWith(".executeCommand") &&
                    node.parent.kind === ts.SyntaxKind.CallExpression
                ) {
                    const argument = (node.parent as ts.CallExpression).arguments[0];
                    const command = getCommand(argument);
                    if (command) {
                        pushCommand(command);
                    } else {
                        const {
                            line,
                            character
                        } = argument
                            .getSourceFile()
                            .getLineAndCharacterOfPosition(argument.pos);
                        dynamicCommanCalls.add(
                            `${argument.getText()} (${
                            argument.getSourceFile().fileName
                            } ${line}:${character})`
                        );
                    }
                }
                if (!symbols.has(qualifiedName) && !missingSymbols.has(qualifiedName)) {
                    let theiaSymbolName = qualifiedName.replace(
                        '"vscode"',
                        '"@theia/plugin"'
                    );
                    theiaSymbolName = theiaSymbolName.replace(
                        "ExtensionContext",
                        "PluginContext"
                    );
                    theiaSymbolName = theiaSymbolName.replace("Extension", "Plugin");
                    theiaSymbolName = theiaSymbolName.replace("extensions", "plugins");
                    if (theiaSymbols.has(theiaSymbolName)) {
                        symbols.add(qualifiedName);
                    } else {
                        missingSymbols.add(qualifiedName);
                    }
                }
            }
        }
    } catch {
        /* no-op */
    }
    ts.forEachChild(node, visit);
};
for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
        continue;
    }
    sourceFile.forEachChild(visit);
}
if (!symbols.size && !missingSymbols.size) {
    console.log('No usages of vscode.d.ts found');
    console.warn('make sure that package dependencies are installed, i.e. run `npm i` or `yarn`');
} else {
    console.log(
        JSON.stringify(
            {
                usedSymbols: Array.from(symbols).sort(),
                usedCommands: Array.from(commands).sort(),
                missingSymbols: Array.from(missingSymbols).sort(),
                missingCommands: Array.from(missingCommands).sort(),
                dynamicCommanCalls: Array.from(dynamicCommanCalls).sort()
            },
            undefined,
            2
        )
    );
}
