let svg, g, tree, root, zoomBehavior;
const margin = { top: 20, right: 120, bottom: 20, left: 120 };
const width = 2400;
const height = 1200;

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

const JSON_INPUT_PLACEHOLDER = 'Enter JSON here, e.g.:\n{\n  "name": "John Doe",\n  "age": 30,\n  "active": true,\n  "address": {\n    "city": "New York",\n    "zip": "10001"\n  },\n  "hobbies": ["reading", "coding"]\n}';

// Builds the gutter + textarea pair used by the input panel. Uses DOM property
// assignment (not innerHTML/string templates) so arbitrary pasted text can never
// be interpreted as markup.
function buildInputEditor(value) {
    const editor = document.createElement('div');
    editor.className = 'editor';

    const lineNumbers = document.createElement('div');
    lineNumbers.className = 'line-numbers';

    const textarea = document.createElement('textarea');
    textarea.setAttribute('wrap', 'off');
    textarea.placeholder = JSON_INPUT_PLACEHOLDER;
    textarea.value = value || '';

    editor.appendChild(lineNumbers);
    editor.appendChild(textarea);
    return editor;
}

function updateLineNumbers(textarea, lineNumbers) {
    const lineCount = textarea.value.split('\n').length;
    const numbers = [];
    for (let n = 1; n <= lineCount; n++) numbers.push(n);
    lineNumbers.textContent = numbers.join('\n');
}

function initInputEditor() {
    const container = document.getElementById('jsonInput');
    const textarea = container.querySelector('textarea');
    const lineNumbers = container.querySelector('.line-numbers');
    if (!textarea || !lineNumbers) return;

    updateLineNumbers(textarea, lineNumbers);

    textarea.addEventListener('input', () => updateLineNumbers(textarea, lineNumbers));
    textarea.addEventListener('scroll', () => {
        lineNumbers.scrollTop = textarea.scrollTop;
    });
}

// Rebuilds the input panel as an editable gutter+textarea pair. Used for the
// initial page load and whenever we drop back into edit mode (editJSON, clearAll).
function renderInputEditor(value) {
    const container = document.getElementById('jsonInput');
    container.innerHTML = '';
    container.appendChild(buildInputEditor(value));
    initInputEditor();
}

// Shows/hides the Fix JSON button. Only ever visible right after a failed
// Visualize; hidden as soon as a parse succeeds (or on Clear/initial load).
function setFixVisible(show) {
    const fixBtn = document.getElementById('fixBtn');
    if (fixBtn) fixBtn.style.display = show ? '' : 'none';
}

function parseJSONOrJSONL(input) {
    try {
        return JSON.parse(input);
    } catch (fullParseError) {
        const lines = input.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length >= 2) {
            const records = [];
            for (const line of lines) {
                try {
                    records.push(JSON.parse(line));
                } catch {
                    throw fullParseError;
                }
            }
            return records;
        }
        throw fullParseError;
    }
}

// Recovers { line, column } for a JSON.parse SyntaxError. Modern engines put
// "position N" and/or "line L column C" in the message; we parse whichever is
// present and derive the other from a newline count over the original input.
function locateErrorPosition(input, error) {
    const msg = error.message || '';
    let position = null;
    let line = null;
    let column = null;

    const posMatch = msg.match(/position (\d+)/);
    if (posMatch) position = parseInt(posMatch[1], 10);

    const lineColMatch = msg.match(/line (\d+) column (\d+)/);
    if (lineColMatch) {
        line = parseInt(lineColMatch[1], 10);
        column = parseInt(lineColMatch[2], 10);
    }

    if (position !== null && (line === null || column === null)) {
        const upToPos = input.slice(0, position).split('\n');
        line = upToPos.length;
        column = upToPos[upToPos.length - 1].length + 1;
    }

    return { line, column };
}

// Builds a small code excerpt (a few lines before/after the failing line) with
// a caret under the failing column. Built entirely via textContent so pasted
// input can never be interpreted as markup.
function buildExcerpt(input, line, column) {
    const lines = input.split('\n');
    const start = Math.max(1, line - 3);
    const end = Math.min(lines.length, line + 3);

    const excerpt = document.createElement('div');
    excerpt.className = 'error-excerpt';

    for (let n = start; n <= end; n++) {
        const row = document.createElement('div');
        row.className = 'error-excerpt-line' + (n === line ? ' error-excerpt-line-active' : '');

        const gutter = document.createElement('span');
        gutter.className = 'error-excerpt-gutter';
        gutter.textContent = String(n);

        const code = document.createElement('span');
        code.className = 'error-excerpt-code';
        code.textContent = lines[n - 1] !== undefined ? lines[n - 1] : '';

        row.appendChild(gutter);
        row.appendChild(code);
        excerpt.appendChild(row);

        if (n === line) {
            const caretRow = document.createElement('div');
            caretRow.className = 'error-excerpt-line error-excerpt-caret-line';

            const caretGutter = document.createElement('span');
            caretGutter.className = 'error-excerpt-gutter';

            const caretCode = document.createElement('span');
            caretCode.className = 'error-excerpt-code';
            caretCode.textContent = ' '.repeat(Math.max(0, column - 1)) + '^';

            caretRow.appendChild(caretGutter);
            caretRow.appendChild(caretCode);
            excerpt.appendChild(caretRow);
        }
    }

    return excerpt;
}

// Scans the raw input for bracket balance, ignoring braces/brackets that
// appear inside string literals (tracking `"` and `\` escapes). Returns any
// still-open brackets (the truncation signal) and the first mismatch found.
// Tracks 1-based line AND column for every opener/closer so a mismatch can be
// pinpointed to one exact character, even when a line has several `]`/`}`.
function analyzeBrackets(input) {
    const pairs = { '{': '}', '[': ']' };
    const stack = [];
    let line = 1;
    let column = 0;
    let inString = false;
    let escapeNext = false;
    let mismatch = null;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        column++;

        if (inString) {
            if (escapeNext) {
                escapeNext = false;
            } else if (ch === '\\') {
                escapeNext = true;
            } else if (ch === '"') {
                inString = false;
            }
        } else if (ch === '"') {
            inString = true;
        } else if (ch === '{' || ch === '[') {
            stack.push({ char: ch, line, column });
        } else if (ch === '}' || ch === ']') {
            const top = stack[stack.length - 1];
            if (!top || pairs[top.char] !== ch) {
                mismatch = {
                    expectedOpener: top ? top.char : null,
                    expectedCloser: top ? pairs[top.char] : null,
                    openerLine: top ? top.line : null,
                    openerColumn: top ? top.column : null,
                    foundCloser: ch,
                    line,
                    column
                };
                break;
            }
            stack.pop();
        }

        if (ch === '\n') {
            line++;
            column = 0;
        }
    }

    return { unclosed: stack, mismatch };
}

function isValidJSON(text) {
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
}

// Best-effort auto-repair for the "Fix JSON" button. Targets the failure modes
// this tool actually surfaces: a paste cut off mid-document (unterminated
// string, unclosed brackets) and stray trailing commas. Not a general JSON
// repair — deliberately simple so it's easy to reason about; fixJSON() falls
// back to the jsonrepair library (loaded from CDN) for anything tougher.
function repairJSON(input) {
    let text = input;

    // Independent scan (not analyzeBrackets, which stops at the first
    // mismatch): we want the full bracket stack even past a mismatch, and
    // whether the input ends mid-string.
    const pairs = { '{': '}', '[': ']' };
    const stack = [];
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escapeNext) {
                escapeNext = false;
            } else if (ch === '\\') {
                escapeNext = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
        } else if (ch === '{' || ch === '[') {
            stack.push(ch);
        } else if (ch === '}' || ch === ']') {
            const top = stack[stack.length - 1];
            if (top && pairs[top] === ch) stack.pop();
            // A closer that doesn't match the top is a real mismatch, not a
            // truncation — this heuristic doesn't try to fix those.
        }
    }

    // A paste cut off mid-string: close the quote before touching anything else.
    if (inString) {
        text += '"';
    }

    text = text.replace(/\s+$/, '');
    text = text.replace(/,\s*$/, ''); // dangling trailing comma at end of input
    // Trailing commas before a closer anywhere in the text. Known limitation:
    // this can also match a literal ",}" inside a string value; acceptable
    // trade-off for a best-effort repair (the CDN fallback handles that case).
    text = text.replace(/,(\s*[}\]])/g, '$1');

    // Close every bracket still open, innermost first.
    for (let i = stack.length - 1; i >= 0; i--) {
        text += pairs[stack[i]];
    }

    return text;
}

// Auto-repairs the current input and re-visualizes. Only reachable while
// #fixBtn is visible, which visualizeJSON() only shows after a failed parse.
function fixJSON() {
    const container = document.getElementById('jsonInput');
    const textarea = container.querySelector('textarea');
    const input = textarea ? textarea.value.trim() : (container.dataset.jsonContent || '');
    if (!input) return;

    let repaired = repairJSON(input);

    if (!isValidJSON(repaired) && typeof JSONRepair !== 'undefined' && typeof JSONRepair.jsonrepair === 'function') {
        try {
            repaired = JSONRepair.jsonrepair(input);
        } catch (jsonRepairError) {
            // jsonrepair couldn't do better either; keep the heuristic's output
            // so the error report at least reflects our best attempt.
        }
    }

    delete container.dataset.jsonContent;
    renderInputEditor(repaired);
    visualizeJSON();
}

// Assembles the full error panel: native message, excerpt+caret, and the
// bracket structure analysis (unclosed/mismatched brackets). Everything is
// built via DOM element creation + textContent, never innerHTML, so pasted
// input can't be interpreted as markup even inside a malformed-JSON payload.
function buildErrorReport(input, error) {
    const report = document.createElement('div');
    report.className = 'error';

    const heading = document.createElement('div');
    heading.className = 'error-heading';
    const strong = document.createElement('strong');
    strong.textContent = 'Error: ';
    heading.appendChild(strong);
    heading.appendChild(document.createTextNode(error.message));
    report.appendChild(heading);

    const { line, column } = locateErrorPosition(input, error);
    if (line !== null && line >= 1 && line <= input.split('\n').length) {
        const excerptLabel = document.createElement('div');
        excerptLabel.className = 'error-section-label';
        excerptLabel.textContent = 'Context:';
        report.appendChild(excerptLabel);
        report.appendChild(buildExcerpt(input, line, column));
    }

    const { unclosed, mismatch } = analyzeBrackets(input);

    const structureLabel = document.createElement('div');
    structureLabel.className = 'error-section-label';
    structureLabel.textContent = 'Structure analysis:';
    report.appendChild(structureLabel);

    const structureBody = document.createElement('div');
    structureBody.className = 'error-structure';

    if (mismatch) {
        const p = document.createElement('p');
        p.textContent = `Mismatched bracket: found "${mismatch.foundCloser}" at line ${mismatch.line}, column ${mismatch.column}, but the innermost open bracket "${mismatch.expectedOpener}" (opened at line ${mismatch.openerLine}, column ${mismatch.openerColumn}) expected a closing "${mismatch.expectedCloser}".`;
        structureBody.appendChild(p);

        // Pinpoint the exact offending closer with a caret, since a line can
        // contain more than one "]"/"}" and the line number alone is ambiguous.
        structureBody.appendChild(buildExcerpt(input, mismatch.line, mismatch.column));
    } else if (unclosed.length > 0) {
        const p = document.createElement('p');
        p.textContent = `${unclosed.length} bracket${unclosed.length > 1 ? 's' : ''} never closed — this usually means the JSON was cut off before the end:`;
        structureBody.appendChild(p);

        const ul = document.createElement('ul');
        unclosed.forEach(u => {
            const li = document.createElement('li');
            li.textContent = `"${u.char}" opened at line ${u.line}`;
            ul.appendChild(li);
        });
        structureBody.appendChild(ul);

        const hint = document.createElement('p');
        hint.className = 'error-hint';
        hint.textContent = 'Tip: this looks like a truncated paste — try re-copying the full JSON output.';
        structureBody.appendChild(hint);
    } else {
        const p = document.createElement('p');
        p.textContent = 'Brackets are balanced — the issue is likely a missing comma, quote, or colon near the highlighted line.';
        structureBody.appendChild(p);
    }

    report.appendChild(structureBody);
    return report;
}

function visualizeJSON() {
    const container = document.getElementById('jsonInput');
    const output = document.getElementById('treeOutput');

    // Get input from textarea or existing content
    let input;
    const textarea = container.querySelector('textarea');
    if (textarea) {
        input = textarea.value.trim();
    } else {
        // Already visualized, get from data attribute
        input = container.dataset.jsonContent;
    }

    if (!input) {
        output.innerHTML = '<div class="empty-state">Please enter some JSON</div>';
        setFixVisible(false);
        return;
    }

    try {
        const json = parseJSONOrJSONL(input);

        // Store the original input
        container.dataset.jsonContent = input;

        // Render JSON as HTML with IDs for each element
        renderJSONAsHTML(json);

        output.innerHTML = '<svg id="tree"></svg>';
        renderTree(json);
        setFixVisible(false);
    } catch (error) {
        output.innerHTML = '';
        output.appendChild(buildErrorReport(input, error));
        setFixVisible(true);
    }
}

function renderJSONAsHTML(json) {
    const container = document.getElementById('jsonInput');

    function renderValue(value, path, indent, isArrayItem = false) {
        let html = '';
        const indentStr = '  '.repeat(indent);

        if (value === null) {
            return `<span class="json-null">null</span>`;
        } else if (typeof value === 'boolean') {
            return `<span class="json-boolean">${value}</span>`;
        } else if (typeof value === 'number') {
            return `<span class="json-number">${value}</span>`;
        } else if (typeof value === 'string') {
            // Check if string is long or contains newlines
            const stringContent = escapeHtml(value);
            const maxLength = 80; // Arbitrary threshold for "long"

            if (stringContent.length > maxLength || stringContent.includes('\n')) {
                // Break long strings into multiple lines for better scrolling
                const lines = [];
                let currentPos = 0;

                // Split by newlines first
                const naturalLines = stringContent.split('\n');
                naturalLines.forEach((line, lineIdx) => {
                    // If line is still too long, break it up
                    if (line.length > maxLength) {
                        for (let i = 0; i < line.length; i += maxLength) {
                            lines.push(line.substring(i, i + maxLength));
                        }
                    } else {
                        lines.push(line);
                    }
                    // Add back newline indicator except for last line
                    if (lineIdx < naturalLines.length - 1) {
                        lines[lines.length - 1] += '\\n';
                    }
                });

                html = '<span class="json-string">"';
                lines.forEach((line, idx) => {
                    html += `<span class="json-string-line">${line}</span>`;
                    if (idx < lines.length - 1) {
                        html += '\n' + indentStr;
                    }
                });
                html += '"</span>';
                return html;
            } else {
                return `<span class="json-string">"${stringContent}"</span>`;
            }
        } else if (Array.isArray(value)) {
            if (value.length === 0) {
                return '[]';
            }
            html += '[\n';
            value.forEach((item, index) => {
                const itemPath = [...path, `[${index}]`];
                const itemId = itemPath.join('/').replace(/\//g, '_');

                html += `${indentStr}  `;
                // For object/array items, wrap in a div for better click handling
                if (typeof item === 'object' && item !== null) {
                    html += `<span id="${itemId}" class="json-item json-clickable-brace">{</span>`;
                    html += renderValue(item, itemPath, indent + 1, true).substring(1); // Remove the opening brace
                } else {
                    html += `<span id="${itemId}" class="json-item">`;
                    html += renderValue(item, itemPath, indent + 1, true);
                    html += '</span>';
                }
                if (index < value.length - 1) html += ',';
                html += '\n';
            });
            html += `${indentStr}]`;
            return html;
        } else if (typeof value === 'object') {
            const keys = Object.keys(value);
            if (keys.length === 0) {
                return '{}';
            }

            html += '{\n';

            keys.forEach((key, index) => {
                const keyPath = [...path, key];
                const keyId = keyPath.join('/').replace(/\//g, '_');
                html += `${indentStr}  <span id="${keyId}" class="json-key-line">`;
                html += `<span class="json-key">"${escapeHtml(key)}"</span>: `;
                html += renderValue(value[key], keyPath, indent + 1, false);
                html += '</span>';
                if (index < keys.length - 1) html += ',';
                html += '\n';
            });
            html += `${indentStr}}`;
            return html;
        }
    }

    const htmlContent = renderValue(json, ['root'], 0, false);
    container.innerHTML = `<pre class="json-display">${htmlContent}</pre>`;

    // Add click handlers to JSON elements
    attachJSONClickHandlers();
}

function attachJSONClickHandlers() {
    const container = document.getElementById('jsonInput');
    const clickableElements = container.querySelectorAll('[id^="root"]');

    clickableElements.forEach(element => {
        element.style.cursor = 'pointer';
        element.addEventListener('click', function(e) {
            e.stopPropagation();

            const elementId = this.id;
            const path = elementId.replace(/_/g, '/').split('/');

            // Find and expand the corresponding tree node
            expandTreeNode(path);
        });
    });
}

function expandTreeNode(path) {
    if (!root) return;

    // Find the node in the tree by path
    function findNode(node, targetPath, currentPath = ['root']) {
        // Check if current node matches
        if (arraysEqual(currentPath, targetPath)) {
            return node;
        }

        // Search in children or _children
        const children = node.children || node._children;
        if (children) {
            for (let child of children) {
                const childPath = [...currentPath, child.data.name];
                const found = findNode(child, targetPath, childPath);
                if (found) return found;
            }
        }

        return null;
    }

    function arraysEqual(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    const targetNode = findNode(root, path);

    if (targetNode) {
        // Expand all ancestors first
        expandAncestors(targetNode);

        // If the node itself is collapsed, expand it
        if (targetNode._children) {
            targetNode.children = targetNode._children;
            targetNode._children = null;
        }

        // Update the tree
        update(targetNode);

        // Center the node in the viewport and highlight it
        setTimeout(() => {
            centerNodeInView(targetNode);
            highlightTreeNode(targetNode);
        }, 600); // Wait for animation to complete
    }
}

function centerNodeInView(node) {
    if (!svg || !g || !zoomBehavior) return;

    // Get the tree-container div dimensions (the visible viewport)
    const treeContainer = document.querySelector('.tree-container');
    const containerRect = treeContainer.getBoundingClientRect();
    const containerWidth = containerRect.width;
    const containerHeight = containerRect.height;

    // Get the SVG element
    const svgElement = svg.node();

    // Get current transform
    const currentTransform = d3.zoomTransform(svgElement);

    // Node position after tree layout (node.x is vertical, node.y is horizontal)
    const nodeX = node.x + margin.top;
    const nodeY = node.y + margin.left;

    // Calculate the translation needed to center the node in the viewport
    const targetX = containerWidth / 2 - nodeY * currentTransform.k;
    const targetY = containerHeight / 2 - nodeX * currentTransform.k;

    // Apply smooth transition to center the node
    svg.transition()
        .duration(750)
        .call(
            zoomBehavior.transform,
            d3.zoomIdentity
                .translate(targetX, targetY)
                .scale(currentTransform.k)
        );
}

function expandAncestors(node) {
    let current = node;
    while (current.parent) {
        if (current.parent._children) {
            current.parent.children = current.parent._children;
            current.parent._children = null;
        }
        current = current.parent;
    }
}

function highlightTreeNode(node) {
    // Find the SVG circle element for this node
    const circles = g.selectAll('circle');
    circles.each(function(d) {
        if (d === node) {
            const circle = d3.select(this);
            const originalFill = circle.style('fill');

            // Flash the node
            circle
                .transition()
                .duration(200)
                .style('fill', '#e74c3c')
                .transition()
                .duration(200)
                .style('fill', originalFill)
                .transition()
                .duration(200)
                .style('fill', '#e74c3c')
                .transition()
                .duration(200)
                .style('fill', originalFill);
        }
    });
}

function editJSON() {
    const container = document.getElementById('jsonInput');
    const currentJSON = container.dataset.jsonContent || '';
    delete container.dataset.jsonContent;
    renderInputEditor(currentJSON);
}

function clearAll() {
    const jsonInput = document.getElementById('jsonInput');
    delete jsonInput.dataset.jsonContent;
    renderInputEditor('');
    document.getElementById('treeOutput').innerHTML = '<div class="empty-state">Enter JSON above and click "Visualize"</div>';
    setFixVisible(false);
}

function truncate(str, maxLen = 15) {
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen) + '...';
}

function jsonToHierarchy(obj, key = 'root', path = []) {
    const node = {
        name: key,
        value: obj,
        path: [...path, key],
        children: []
    };

    if (obj === null) {
        node.type = 'null';
        node.fullValue = 'null';
        node.displayValue = 'null';
    } else if (typeof obj === 'string') {
        node.type = 'string';
        node.fullValue = `"${obj}"`;
        node.displayValue = truncate(`"${obj}"`);
    } else if (typeof obj === 'number') {
        node.type = 'number';
        node.fullValue = obj.toString();
        node.displayValue = truncate(obj.toString());
    } else if (typeof obj === 'boolean') {
        node.type = 'boolean';
        node.fullValue = obj.toString();
        node.displayValue = obj.toString();
    } else if (Array.isArray(obj)) {
        node.type = 'array';
        node.displayValue = '[]';
        if (obj.length > 0) {
            node.children = obj.map((item, index) => jsonToHierarchy(item, `[${index}]`, node.path));
        }
    } else if (typeof obj === 'object') {
        node.type = 'object';
        node.displayValue = '{}';
        const keys = Object.keys(obj);
        if (keys.length > 0) {
            node.children = keys.map(k => jsonToHierarchy(obj[k], k, node.path));
        }
    }

    if (node.children.length === 0) {
        delete node.children;
    }

    return node;
}

function renderTree(data) {
    const treeData = jsonToHierarchy(data);

    svg = d3.select("#tree")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom);

    // Add zoom behavior
    zoomBehavior = d3.zoom()
        .scaleExtent([0.1, 3])
        .on("zoom", (event) => {
            g.attr("transform", event.transform);
        });

    svg.call(zoomBehavior);

    g = svg.append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    tree = d3.tree().size([height - 100, width - 160]);
    root = d3.hierarchy(treeData);
    root.x0 = height / 2;
    root.y0 = 0;

    // Collapse all children initially
    if (root.children) {
        root.children.forEach(collapse);
    }

    update(root);
}

function collapse(d) {
    if (d.children) {
        d._children = d.children;
        d._children.forEach(collapse);
        d.children = null;
    }
}

function update(source) {
    const treeData = tree(root);
    const nodes = treeData.descendants();
    const links = treeData.descendants().slice(1);

    // Normalize for fixed-depth
    nodes.forEach(d => { d.y = d.depth * 180; });

    // Update nodes
    const node = g.selectAll('g.node')
        .data(nodes, d => d.id || (d.id = ++i));

    // Enter new nodes
    const nodeEnter = node.enter().append('g')
        .attr('class', d => {
            const isLeaf = !d.children && !d._children && d.data.fullValue;
            return isLeaf ? 'node leaf' : 'node';
        })
        .attr("transform", d => `translate(${source.y0},${source.x0})`)
        .on('click', click);

    nodeEnter.append('circle')
        .attr('r', 5)
        .style("fill", d => d._children ? "#3498db" : "#fff");

    nodeEnter.append('text')
        .attr("dy", ".35em")
        .attr("x", 13)
        .attr("text-anchor", "start")
        .each(function(d) {
            const text = d3.select(this);
            const data = d.data;

            if (data.name !== 'root') {
                text.append('tspan')
                    .attr('class', 'node-key')
                    .text(`${data.name}: `);
            }

            if (data.type === 'string') {
                text.append('tspan')
                    .attr('class', 'node-string')
                    .text(data.displayValue);
            } else if (data.type === 'number') {
                text.append('tspan')
                    .attr('class', 'node-number')
                    .text(data.displayValue);
            } else if (data.type === 'boolean') {
                text.append('tspan')
                    .attr('class', 'node-boolean')
                    .text(data.displayValue);
            } else if (data.type === 'null') {
                text.append('tspan')
                    .attr('class', 'node-null')
                    .text(data.displayValue);
            } else {
                text.append('tspan')
                    .attr('class', 'node-bracket')
                    .text(data.displayValue);
            }
        });

    // Update
    const nodeUpdate = nodeEnter.merge(node);

    nodeUpdate.transition()
        .duration(500)
        .attr("transform", d => `translate(${d.y},${d.x})`);

    nodeUpdate.select('circle')
        .attr('r', 5)
        .style("fill", d => d._children ? "#3498db" : "#fff")
        .attr('cursor', 'pointer');

    // Remove old nodes
    const nodeExit = node.exit().transition()
        .duration(500)
        .attr("transform", d => `translate(${source.y},${source.x})`)
        .remove();

    nodeExit.select('circle')
        .attr('r', 1e-6);

    nodeExit.select('text')
        .style('fill-opacity', 1e-6);

    // Update links
    const link = g.selectAll('path.link')
        .data(links, d => d.id);

    const linkEnter = link.enter().insert('path', "g")
        .attr("class", "link")
        .attr('d', d => {
            const o = {x: source.x0, y: source.y0};
            return diagonal(o, o);
        });

    const linkUpdate = linkEnter.merge(link);

    linkUpdate.transition()
        .duration(500)
        .attr('d', d => diagonal(d, d.parent));

    link.exit().transition()
        .duration(500)
        .attr('d', d => {
            const o = {x: source.x, y: source.y};
            return diagonal(o, o);
        })
        .remove();

    nodes.forEach(d => {
        d.x0 = d.x;
        d.y0 = d.y;
    });
}

function diagonal(s, d) {
    return `M ${s.y} ${s.x}
            C ${(s.y + d.y) / 2} ${s.x},
              ${(s.y + d.y) / 2} ${d.x},
              ${d.y} ${d.x}`;
}

let i = 0;

function click(event, d) {
    event.stopPropagation();

    // Scroll to the node in JSON input
    scrollToNodeInJSON(d.data);

    // If it's a leaf node with a full value, show popover
    if (!d.children && !d._children && d.data.fullValue) {
        const content = d.data.name !== 'root'
            ? `${d.data.name}: ${d.data.fullValue}`
            : d.data.fullValue;
        showPopover(event, content);
    } else if (d.children || d._children) {
        // If it's a parent node, toggle expand/collapse
        if (d.children) {
            d._children = d.children;
            d.children = null;
        } else {
            d.children = d._children;
            d._children = null;
        }
        update(d);
    }
}

function scrollToNodeInJSON(nodeData) {
    const container = document.getElementById('jsonInput');

    try {
        // Build element ID from path
        const pathKey = nodeData.path.join('/');
        const elementId = pathKey.replace(/\//g, '_');
        const element = document.getElementById(elementId);

        if (!element) {
            console.error('Element not found for path:', pathKey);
            return;
        }

        // Scroll the element into view
        element.scrollIntoView({ behavior: 'smooth', block: 'start' });

        // Highlight the element temporarily
        // For anchor elements, highlight the next sibling or parent
        const highlightTarget = element.classList.contains('json-anchor')
            ? element.parentElement
            : element;
        highlightTarget.classList.add('json-highlight');

        // Remove highlight after a moment
        setTimeout(() => {
            highlightTarget.classList.remove('json-highlight');
        }, 1500);
    } catch (error) {
        console.error('Error scrolling to node:', error);
    }
}

function showPopover(event, content) {
    const popover = document.getElementById('popover');
    const popoverContent = popover.querySelector('.popover-content');

    popoverContent.textContent = content;
    popover.classList.add('visible');

    // Position the popover near the click
    const x = event.pageX + 10;
    const y = event.pageY + 10;
    popover.style.left = x + 'px';
    popover.style.top = y + 'px';
}

function hidePopover() {
    const popover = document.getElementById('popover');
    popover.classList.remove('visible');
}

// Click outside to dismiss popover
document.addEventListener('click', (event) => {
    const popover = document.getElementById('popover');
    if (popover.classList.contains('visible') && !popover.contains(event.target)) {
        hidePopover();
    }
});

// Auto-visualize on Enter; Shift+Enter inserts a newline
document.getElementById('jsonInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        visualizeJSON();
    }
});

// Initial editor render (adds the line-number gutter to the starting textarea)
renderInputEditor('');
setFixVisible(false);
