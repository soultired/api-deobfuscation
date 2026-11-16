// Port từ decrypt_v1.js (jsjiami v6: mảng chuỗi + vòng xoay + hàm giải mã RC4).
// Các bước dọn code (unpackObfDicts ... removeObfConstants) giữ nguyên từ bản gốc.
// Khác bản gốc:
//  1. Bản gốc chép cứng mảng chuỗi và tên hàm _0x1e77 của một file cụ thể rồi dùng regex để thay.
//     Ở đây mảng + vòng xoay + hàm giải mã được tự tìm trong file đầu vào và chạy trong vm.
//  2. console -> ghi vào log trả về cho API
//  3. main() đọc/ghi file -> deobfuscate(code) nhận và trả chuỗi
const { console, evalDecoder } = require('./runtime');

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const generator = require('@babel/generator').default;

function isSimpleReturn(bodyBlock) {
    if (!bodyBlock || !bodyBlock.body || bodyBlock.body.length !== 1) return false;
    return t.isReturnStatement(bodyBlock.body[0]);
}

var unpackObfDicts = (sourceCode) => {
    let currentCode = sourceCode;
    let loopCount = 0;
    const MAX_LOOPS = 20;

    let processedDictNames = new Set();

    while (loopCount < MAX_LOOPS) {
        loopCount++;
        let hasChanged = false;

        const ast = parser.parse(currentCode);
        let allDicts = {};

        // --- 步骤一：寻找字典 ---
        traverse(ast, {
            VariableDeclarator(path) {
                if (path.node.init && t.isObjectExpression(path.node.init)) {
                    const properties = path.node.init.properties;
                    // if (properties.length < 3) return;

                    let tempDict = {};
                    let isLikelyObfuscatedDict = true;

                    for (let prop of properties) {
                        if (!prop.key) { isLikelyObfuscatedDict = false; break; }
                        const key = prop.key.value || prop.key.name;
                        const val = prop.value;

                        // 1. 字符串映射
                        if (t.isStringLiteral(val)) {
                            tempDict[key] = { type: 'string', value: val.value };
                        }
                        // 2. 函数映射
                        else if (t.isFunctionExpression(val) && isSimpleReturn(val.body)) {
                            const retArg = val.body.body[0].argument;
                            const params = val.params.map(p => p.name); // 获取函数参数名列表

                            if (t.isBinaryExpression(retArg)) {
                                tempDict[key] = { type: 'binary', operator: retArg.operator };
                            }
                            else if (t.isLogicalExpression(retArg)) {
                                tempDict[key] = { type: 'logical', operator: retArg.operator };
                            }
                            else if (t.isCallExpression(retArg)) {
                                // 重点修复逻辑：区分 "执行参数" 和 "执行别名"
                                const callee = retArg.callee;

                                // 情况 A: 调用的是参数之一 (例如: return fn(a, b))
                                if (t.isIdentifier(callee) && params.includes(callee.name)) {
                                    tempDict[key] = { type: 'call_indirect' }; // 标记为间接调用
                                }
                                // 情况 B: 调用的不是参数 (例如: return _0x56da17["FYuCb"](a, b))
                                else {
                                    // 我们需要把被调用的那个节点保存下来
                                    // 注意：这里保存的是 AST 节点，比如 _0x56da17["FYuCb"]
                                    tempDict[key] = { type: 'call_alias', calleeNode: callee };
                                }
                            }
                        }
                    }

                    if (isLikelyObfuscatedDict && Object.keys(tempDict).length > 0) {
                        const dictName = path.node.id.name;
                        allDicts[dictName] = tempDict;

                        // 新增：记录名字
                        processedDictNames.add(dictName);
                    }
                }
            }
        });

        if (Object.keys(allDicts).length === 0) {
            if (loopCount === 1) console.log("未检测到标准混淆字典。");
            break;
        }

        console.log(`第 ${loopCount} 轮: 发现 ${Object.keys(allDicts).length} 个字典。正在替换...`);

        // --- 步骤二：执行替换 ---
        traverse(ast, {
            // 字符串处理 (保持不变)
            MemberExpression(path) {
                if (path.removed) return;
                const objectName = path.node.object.name;
                const propertyName = path.node.property.value || path.node.property.name;

                if (t.isCallExpression(path.parent) && path.parent.callee === path.node) return;

                if (allDicts[objectName] && allDicts[objectName][propertyName]) {
                    const mapping = allDicts[objectName][propertyName];
                    if (mapping.type === 'string') {
                        path.replaceWith(t.stringLiteral(mapping.value));
                        hasChanged = true;
                    }
                }
            },

            // 函数调用处理
            CallExpression(path) {
                if (path.removed) return;
                const callee = path.node.callee;
                if (!t.isMemberExpression(callee)) return;

                const objectName = callee.object.name;
                const propertyName = callee.property.value || callee.property.name;

                if (allDicts[objectName] && allDicts[objectName][propertyName]) {
                    const mapping = allDicts[objectName][propertyName];
                    const args = path.node.arguments;

                    if (mapping.type === 'binary') {
                        if (args.length >= 2) {
                            path.replaceWith(t.binaryExpression(mapping.operator, args[0], args[1]));
                            hasChanged = true;
                        }
                    }
                    else if (mapping.type === 'logical') {
                        if (args.length >= 2) {
                            path.replaceWith(t.logicalExpression(mapping.operator, args[0], args[1]));
                            hasChanged = true;
                        }
                    }
                    // 修复点：处理间接调用 (return arg0(arg1))
                    else if (mapping.type === 'call_indirect') {
                        if (args.length >= 1) {
                            const realFunc = args[0];
                            const realArgs = args.slice(1);
                            path.replaceWith(t.callExpression(realFunc, realArgs));
                            hasChanged = true;
                        }
                    }
                    // 修复点：处理直接别名 (return GlobalFunc(arg0, arg1))
                    else if (mapping.type === 'call_alias') {
                        // 这里的 args 就是直接传递给内部函数的参数
                        // 我们只需要用 mapping.calleeNode (即那个 GlobalFunc 节点) 替换掉当前的 dict['method']
                        // 必须使用 t.cloneNode，因为 AST 节点不能重复使用
                        const newCallee = t.cloneNode(mapping.calleeNode);
                        path.replaceWith(t.callExpression(newCallee, args));
                        hasChanged = true;
                    }
                }
            }
        });

        if (hasChanged) {
            currentCode = generator(ast, { jsescOption: { minimal: true } }).code;
        } else {
            console.log("代码已稳定，停止解包。");
            break;
        }
    }

    return {
        code: currentCode,
        dictNames: Array.from(processedDictNames)
    };
};

var removeObfDicts = (sourceCode, targetDictNames) => {
    // 如果没有名单，为了安全起见，我们什么都不做，或者你可以改为移除所有无用对象
    if (!targetDictNames || targetDictNames.length === 0) return sourceCode;

    const ast = parser.parse(sourceCode);
    let removedCount = 0;

    traverse(ast, {
        VariableDeclarator(path) {
            const { id, init } = path.node;
            const varName = id.name;

            // 1. 检查名字：必须是我们解包过的字典
            if (!targetDictNames.includes(varName)) return;

            // 2. 检查结构：必须是对象定义 var x = { ... }
            if (!init || !t.isObjectExpression(init)) return;

            // 3. 核心检查：检查引用计数 (Reference Count)
            // path.scope.getBinding 会获取该变量在作用域内的所有信息
            const binding = path.scope.getBinding(varName);

            // binding.referenced 为 false 表示没有任何代码读取或调用这个变量
            if (binding && !binding.referenced) {
                // 安全移除
                path.remove();
                removedCount++;
            }
        }
    });

    console.log(`清理完成：移除了 ${removedCount} 个遗留的混淆字典。`);
    return generator(ast, { jsescOption: { minimal: true } }).code;
};

var removeObfIfStatement = (sourceCode) => {
    // 1. 将源代码解析为 AST
    // sourceType: 'module' 允许解析 import/export 等语法
    const ast = parser.parse(sourceCode, {
        sourceType: 'module'
    });

    // 2. 遍历 AST
    traverse(ast, {
        // 访问每一个 IfStatement 节点
        IfStatement(path) {
            const node = path.node;
            const test = node.test;

            // 3. 检测：我们需要过滤出特定的结构
            // 结构特征：if ("str" op "str")
            // 判断条件必须是二元表达式 (BinaryExpression)
            if (!t.isBinaryExpression(test)) return;

            // 判断左右两边是否都是字符串字面量 (StringLiteral)
            if (!t.isStringLiteral(test.left) || !t.isStringLiteral(test.right)) return;

            // 4. 求值：手动计算这个表达式的结果
            // 获取左右两边的字符串值
            const leftVal = test.left.value;
            const rightVal = test.right.value;
            const operator = test.operator;

            let result = null;

            // 根据操作符进行运算 (针对你提到的 ===, !==, ==, !=)
            switch (operator) {
                case '===':
                case '==':
                    result = leftVal === rightVal;
                    break;
                case '!==':
                case '!=':
                    result = leftVal !== rightVal;
                    break;
                // 如果有其他操作符可以在这里补充
            }

            // 如果结果没有被计算出来（不是我们要的操作符），则跳过
            if (result === null) return;

            // 5. 替换：根据计算结果保留代码分支

            if (result === true) {
                // 情况 A: 结果为真，只保留 if 里面的代码 (consequent)
                // 这里的处理是为了去掉多余的花括号 {}
                if (t.isBlockStatement(node.consequent)) {
                    // 如果里面是代码块 { ... }，用代码块里的语句列表替换当前节点
                    path.replaceWithMultiple(node.consequent.body);
                } else {
                    // 如果里面只有一句代码 (没有花括号)，直接替换
                    path.replaceWith(node.consequent);
                }
            } else {
                // 情况 B: 结果为假，只保留 else 里面的代码 (alternate)
                if (node.alternate) {
                    // 如果存在 else 块
                    if (t.isBlockStatement(node.alternate)) {
                        path.replaceWithMultiple(node.alternate.body);
                    } else {
                        path.replaceWith(node.alternate);
                    }
                } else {
                    // 如果结果为假，且没有 else，说明整个 if 语句都可以删掉
                    path.remove();
                }
            }

            // 这是一个好习惯：如果你替换了节点，建议停止处理当前路径的子节点，或者重新根据需要处理
            // 这里因为我们替换了整个 If 语句，通常不需要再深究旧的结构了
        }
    });

    // 6. 生成代码
    // jsescOption: { minimal: true } 可以在生成代码时尽量少用转义符
    console.log("条件语句清理完成。");
    return generator(ast, { jsescOption: { minimal: true } }).code;
}

var removeObfFunc = (sourceCode) => {
    // === 阶段一：内联替换 (Inlining) ===
    // 这个阶段我们只关注把代码展开，不关心删除，避免 Scope 问题干扰

    let ast = parser.parse(sourceCode);
    let changed = true;
    let loopCount = 0;

    function getProxyFunctionInfo(path) {
        const { node } = path;
        const body = node.body.body;
        if (body.length !== 1 || !t.isReturnStatement(body[0])) return null;
        const returnArg = body[0].argument;
        if (!returnArg) return null;
        return { returnArg };
    }

    while (changed && loopCount < 50) {
        changed = false;
        loopCount++;

        // 每次循环重新遍历，确保获取最新状态
        traverse(ast, {
            FunctionDeclaration(path) {
                const proxyInfo = getProxyFunctionInfo(path);
                if (!proxyInfo) return;

                const { node } = path;
                const params = node.params;
                const { returnArg } = proxyInfo;
                const binding = path.scope.getBinding(node.id.name);

                if (!binding || !binding.constant) return;

                binding.referencePaths.forEach(refPath => {
                    const callExprPath = refPath.parentPath;
                    if (!t.isCallExpression(callExprPath.node) ||
                        callExprPath.node.callee !== refPath.node ||
                        callExprPath.node.arguments.length !== params.length) {
                        return;
                    }

                    const args = callExprPath.node.arguments;
                    const newExpr = t.cloneNode(returnArg);
                    const replaceMap = {};

                    params.forEach((param, index) => {
                        if (t.isIdentifier(param)) replaceMap[param.name] = args[index];
                    });

                    traverse(t.file(t.program([t.expressionStatement(newExpr)])), {
                        Identifier(innerPath) {
                            const pName = innerPath.node.name;
                            if (replaceMap.hasOwnProperty(pName)) {
                                innerPath.replaceWith(t.cloneNode(replaceMap[pName]));
                                innerPath.skip();
                            }
                        },
                        noScope: true
                    });

                    callExprPath.replaceWith(newExpr);
                    changed = true;
                });
            }
        });
    }

    // =======================================================
    // 关键修复步骤：重新生成代码并重新解析 (Flush AST)
    // =======================================================
    // 此时内存中的 AST 可能包含大量已经断开连接的节点导致的“幽灵引用”。
    // 我们将代码生成出来，这会自动丢弃所有不在树上的节点。
    // 然后重新解析，得到一个干净的、引用计数准确的 AST。
    let cleanCode = generator(ast).code;
    ast = parser.parse(cleanCode);

    // =======================================================
    // 阶段二：清理死代码 (Cleanup)
    // =======================================================

    let cleanupChanged = true;
    let cleanupLoopCount = 0;

    while (cleanupChanged && cleanupLoopCount < 50) {
        cleanupChanged = false;
        cleanupLoopCount++;

        traverse(ast, {
            FunctionDeclaration(path) {
                const fnName = path.node.id.name;
                const binding = path.scope.getBinding(fnName);

                // 如果没有 binding，说明是个很奇怪的孤立节点，或者已经被移除
                if (!binding) return;

                // 策略 A：基于 AST 的智能引用检查 (现在因为 Re-parse 变准了)
                const externalRefs = binding.referencePaths.filter(refPath => {
                    return !refPath.findParent(p => p === path);
                });

                if (externalRefs.length === 0) {
                    path.remove();
                    cleanupChanged = true;
                    return; // 删掉了就不用执行策略 B 了
                }

                // 策略 B：暴力文本检查 (响应你的要求)
                // 如果 AST 依然因为某种原因抽风 (比如 Scope 没更新)，我们用正则表达式检查
                // 条件：
                // 1. 函数名比较长 (避免误伤变量 'a', 'b')，混淆名通常 > 3 字符
                // 2. 整个 sourceCode 里，这个名字出现的次数 == 1 (只有定义处)
                // 注意：这种方法比较耗时，但对于解决最后几个顽固分子很有效

                if (fnName.length > 3 && fnName.startsWith('_0x')) {
                    // 这里我们需要当前的源码字符串。由于 traverse 过程中 ast 在变，
                    // 每次 generate 会很慢。但我们可以只在 externalRefs > 0 但看起来很可疑时做。

                    // 简单的正则匹配次数
                    const regex = new RegExp(fnName.replace('$', '\\$'), 'g');
                    // 注意：这里用的是刚生成的 cleanCode，可能略有滞后，但对于清理阶段足够了
                    // 更好的方式是只在最后做一次暴力清理，但这里放在循环里也行
                    const matchCount = (cleanCode.match(regex) || []).length;

                    // 如果文本里只出现了一次（就是函数定义本身），那就强制删除
                    if (matchCount === 1) {
                        console.log(`[Force Delete] 强制删除僵尸函数: ${fnName}`);
                        path.remove();
                        cleanupChanged = true;
                    }
                }
            }
        });

        // 如果发生了改变，更新 cleanCode，以便下一轮暴力检查使用
        if (cleanupChanged) {
            cleanCode = generator(ast).code;
        }
    }

    return cleanCode;
};

var removeObfConstants = (sourceCode) => {
    let ast = parser.parse(sourceCode);

    // 设置一个标志位，用于判断AST是否发生了改变
    let changed = true;
    let loopLimit = 200; // 防止死循环，设置最大轮数

    // 循环执行，直到没有新的替换发生，或者达到最大轮数
    while (changed && loopLimit > 0) {
        changed = false;
        loopLimit--;

        traverse(ast, {
            // 1. 处理字符串拼接 "str" + "ing"
            BinaryExpression(path) {
                const { left, right, operator } = path.node;

                // 只处理 "+" 运算符
                if (operator !== '+') return;

                // 检查左边和右边是否都是字面量 (StringLiteral, NumericLiteral 等)
                if (t.isLiteral(left) && t.isLiteral(right)) {
                    // 确保是字符串拼接 (通常至少有一边是字符串)
                    if (typeof left.value === 'string' || typeof right.value === 'string') {
                        // 计算结果
                        const result = left.value + right.value;
                        // 替换节点为新的字符串常量
                        path.replaceWith(t.stringLiteral(result));
                        changed = true;
                    }
                }
            },

            // 2. 处理属性访问 "string"["length"] 或 "string".length
            MemberExpression(path) {
                const { object, property, computed } = path.node;

                // 目标必须是字符串常量
                if (!t.isStringLiteral(object)) return;

                // 获取属性名
                let propName;
                if (computed && t.isStringLiteral(property)) {
                    // 形式: "str"['length']
                    propName = property.value;
                } else if (!computed && t.isIdentifier(property)) {
                    // 形式: "str".length
                    propName = property.name;
                }

                // 处理 .length 属性
                if (propName === 'length') {
                    const result = object.value.length;
                    // 替换为数字常量
                    path.replaceWith(t.numericLiteral(result));
                    changed = true;
                }

                // (可选) 如果需要处理 "abc"[0] 这种索引访问，可以在这里加逻辑
            },

            // 3. 处理变量常量替换 (之前的逻辑)
            VariableDeclarator(path) {
                const { id, init } = path.node;

                // 必须有初始值，且初始值必须是 字面量 (String, Number, Boolean)
                // 这里放宽了条件，不仅支持字符串，也支持数字等，只要是Literal即可
                if (!init || !t.isLiteral(init)) return;
                if (!t.isIdentifier(id)) return;

                const binding = path.scope.getBinding(id.name);
                if (!binding || !binding.constant) return;

                // 如果该变量没有被引用，说明是死代码（或者已经被我们在之前的循环中替换完了）
                // 可以直接删除，净化代码
                if (binding.referencePaths.length === 0) {
                    path.remove();
                    changed = true;
                    return;
                }

                // 执行替换
                for (const refPath of binding.referencePaths) {
                    // 此时 init 必定是 Literal，直接根据类型创建对应的 Literal 节点
                    // 使用 t.cloneNode 复制节点，防止引用同一个对象出错
                    refPath.replaceWith(t.cloneNode(init));
                }

                // 替换完成后，标记发生了改变
                changed = true;

                // 注意：这里我们不直接 remove，而是等到下一轮循环时
                // binding.referencePaths.length 变成 0 了再由上面的逻辑删除
                // 这样逻辑更清晰
            }
        });
    }

    return generator(ast, { jesc: true }).code;
}


// ---------------------------------------------------------------------------
// Phần mới: tìm mảng chuỗi, vòng xoay và hàm giải mã trong chính file đầu vào,
// chạy chúng trong vm, rồi thay mọi lời gọi decoder('0x..', 'key') bằng chuỗi thật.
// ---------------------------------------------------------------------------
const DECODER_INDEX_RE = /^(?:0x[0-9a-f]+|\d+)$/i;

function isStringPairCall(node) {
    return t.isCallExpression(node)
        && t.isIdentifier(node.callee)
        && node.arguments.length === 2
        && t.isStringLiteral(node.arguments[0])
        && t.isStringLiteral(node.arguments[1]);
}

// Hàm giải mã là tên được gọi nhiều nhất dưới dạng name('0x1a', 'key') và được khai báo ở cấp cao nhất.
function findV6Decoder(ast) {
    const counts = new Map();
    traverse(ast, {
        CallExpression(path) {
            if (isStringPairCall(path.node) && DECODER_INDEX_RE.test(path.node.arguments[0].value)) {
                const name = path.node.callee.name;
                counts.set(name, (counts.get(name) || 0) + 1);
            }
        }
    });

    const ranked = Array.from(counts.entries()).sort((left, right) => right[1] - left[1]);
    for (const [name, count] of ranked) {
        const index = ast.program.body.findIndex(statement =>
            t.isVariableDeclaration(statement) &&
            statement.declarations.some(d => t.isIdentifier(d.id, { name }) && (t.isFunctionExpression(d.init) || t.isArrowFunctionExpression(d.init)))
        );
        if (index >= 0) {
            return { name, index, calls: count };
        }
    }
    return null;
}

function replaceV6Strings(sourceCode) {
    let ast = parser.parse(sourceCode, { sourceType: 'unambiguous' });
    const found = findV6Decoder(ast);

    if (!found) {
        console.warn('Không tìm thấy hàm giải mã jsjiami v6 (mảng chuỗi + vòng xoay + decoder) ở cấp cao nhất của file.');
        return { code: sourceCode, replaced: 0 };
    }

    // Mảng chuỗi, vòng xoay và decoder nằm trước/ở đúng câu lệnh khai báo decoder. Lấy nguyên văn, không in lại bằng generator.
    const body = ast.program.body;
    const prefix = sourceCode.slice(body[0].start, body[found.index].end);

    let decode;
    try {
        decode = evalDecoder(prefix, found.name);
    } catch (error) {
        console.error(`Không chạy được mảng chuỗi và decoder ${found.name}: ${error && error.message ? error.message : error}`);
        return { code: sourceCode, replaced: 0 };
    }
    console.log(`Tìm thấy decoder ${found.name} (${found.calls} lời gọi).`);

    const cache = new Map();
    const decodeCached = (index, key) => {
        const cacheKey = `${index}\u0000${key}`;
        if (!cache.has(cacheKey)) {
            let value = null;
            try {
                const result = decode(index, key);
                value = typeof result === 'string' ? result : null;
            } catch (error) {
                value = null;
            }
            cache.set(cacheKey, value);
        }
        return cache.get(cacheKey);
    };

    let code = sourceCode;
    let replaced = 0;
    let failed = 0;

    for (let round = 0; round < 8; round++) {
        const names = new Set([found.name]);
        traverse(ast, {
            VariableDeclarator(path) {
                if (t.isIdentifier(path.node.id) && t.isIdentifier(path.node.init) && names.has(path.node.init.name)) {
                    names.add(path.node.id.name);
                }
            }
        });

        const edits = [];
        traverse(ast, {
            CallExpression(path) {
                if (!isStringPairCall(path.node) || !names.has(path.node.callee.name)) {
                    return;
                }
                const value = decodeCached(path.node.arguments[0].value, path.node.arguments[1].value);
                if (value === null) {
                    failed++;
                    return;
                }
                edits.push({ start: path.node.start, end: path.node.end, text: JSON.stringify(value) });
                path.skip();
            }
        });

        if (edits.length === 0) {
            break;
        }

        edits.sort((left, right) => right.start - left.start);
        for (const edit of edits) {
            code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
        }
        replaced += edits.length;
        ast = parser.parse(code, { sourceType: 'unambiguous' });
    }

    console.log(`Đã thay ${replaced} lời gọi bằng chuỗi thật${failed ? `, ${failed} lời gọi không giải được` : ''}.`);
    return { code, replaced };
}

function deobfuscate(originalCode) {
    const decoded = replaceV6Strings(originalCode);
    const unpackedResult = unpackObfDicts(decoded.code);
    const noDictCode = removeObfDicts(unpackedResult.code, unpackedResult.dictNames);
    const cleanedCode = removeObfIfStatement(noDictCode);
    const noObfFuncCode = removeObfFunc(cleanedCode);
    return removeObfConstants(noObfFuncCode);
}

module.exports = { deobfuscate, replaceV6Strings };

