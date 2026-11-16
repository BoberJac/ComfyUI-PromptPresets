import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Стиль кнопок из Anima-Tools (компактная версия)
function baseButtonStyle() {
    return `
        height: 28px;
        border-radius: 5px;
        border: 1px solid rgba(255,255,255,0.12);
        color: #e5e7eb;
        font-size: 11px;
        font-weight: 600;
        line-height: 1;
        cursor: pointer;
        pointer-events: auto;
        transition: background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
    `;
}

// Ключ, под которым состояние тумблера хранится в свойствах ноды (сохраняется в воркфлоу)
const AUTO_SAVE_KEY = "promptPresetsAutoSave";
// Пауза после последнего изменения поля, прежде чем сохранять
const AUTO_SAVE_DELAY = 1200;
// Как часто проверяем, изменились ли поля
const POLL_INTERVAL = 600;

// Расширение для Prompt Presets Node
app.registerExtension({
    name: "PromptPresets.ButtonControls",
    
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "PromptPresetsNode") {
            
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function() {
                const result = onNodeCreated?.apply(this, arguments);
                
                const node = this;
                
                // Устанавливаем дефолтный размер ноды (компактная)
                node.setSize([520, 600]);
                
                
                // Находим виджеты
                const presetWidget = node.widgets.find(w => w.name === "preset");
                const positiveWidget = node.widgets.find(w => w.name === "positive");
                const negativeWidget = node.widgets.find(w => w.name === "negative");
                const presetNameWidget = node.widgets.find(w => w.name === "preset_name");
                
                if (!presetWidget || !positiveWidget || !negativeWidget) {
                    console.error("PromptPresets: required widgets not found");
                    return result;
                }
                
                // ===== СОСТОЯНИЕ АВТО-СОХРАНЕНИЯ =====
                let lastSnapshot = {
                    positive: positiveWidget.value,
                    negative: negativeWidget.value,
                    preset: presetWidget.value
                };
                let autoSaveTimer = null;
                let isProgrammatic = false;  // защита: не сохраняем то, что мы сами записали
                let creatingNew = false;     // режим "создаю новый пресет" — авто-сохранение молчит
                
                function isAutoSaveEnabled() {
                    node.properties = node.properties || {};
                    return node.properties[AUTO_SAVE_KEY] !== false; // по умолчанию включено
                }
                
                function takeSnapshot() {
                    lastSnapshot = {
                        positive: positiveWidget.value,
                        negative: negativeWidget.value,
                        preset: presetWidget.value
                    };
                }
                
                // ===== ОБНОВЛЕНИЕ СПИСКА ПРЕСЕТОВ =====
                async function refreshPresetList() {
                    try {
                        const response = await api.fetchApi("/prompt_presets/get_presets");
                        const presets = await response.json();
                        const presetNames = Object.keys(presets);
                        
                        // Если пресетов нет — добавляем дефолтный
                        if (presetNames.length === 0) {
                            presetNames.push("Default");
                        }
                        
                        presetWidget.options.values = presetNames;
                    } catch (error) {
                        console.error("PromptPresets: failed to refresh preset list", error);
                    }
                }
                
                // ===== ЗАГРУЗКА ПРЕСЕТА ПО ИМЕНИ =====
                async function loadPresetByName(name) {
                    try {
                        const response = await api.fetchApi("/prompt_presets/get_presets");
                        const presets = await response.json();
                        
                        isProgrammatic = true;
                        creatingNew = false;
                        
                        if (presets[name]) {
                            positiveWidget.value = presets[name].positive || "";
                            negativeWidget.value = presets[name].negative || "";
                            // Подтягиваем имя загруженного пресета в поле preset_name,
                            // чтобы Save перезаписывал этот же пресет, а не создавал дубль
                            if (presetNameWidget) {
                                presetNameWidget.value = name;
                            }
                        } else {
                            console.warn(`PromptPresets: preset "${name}" not found`);
                        }
                        
                        takeSnapshot();
                        isProgrammatic = false;
                        refreshTokenCount();
                    } catch (error) {
                        isProgrammatic = false;
                        console.error("PromptPresets: failed to load preset", error);
                    }
                }
                
                // ===== АВТО-СОХРАНЕНИЕ =====
                function scheduleAutoSave() {
                    clearTimeout(autoSaveTimer);
                    
                    // СРАЗУ обновляем snapshot, чтобы поллинг перестал спамить
                    takeSnapshot();
                    
                    autoSaveTimer = setTimeout(doAutoSave, AUTO_SAVE_DELAY);
                }
                
                async function doAutoSave() {
                    
                    // Сбрасываем таймер — scheduleAutoSave может запланировать новый
                    autoSaveTimer = null;
                    
                    if (isProgrammatic || creatingNew) {
                        return;
                    }
                    if (!isAutoSaveEnabled()) {
                        return;
                    }
                    
                    const name = presetWidget.value;
                    if (!name) {
                        console.warn("PromptPresets: no preset selected, auto-save skipped");
                        return;
                    }
                    
                    const positive = positiveWidget.value;
                    const negative = negativeWidget.value;
                    
                    
                    try {
                        const response = await api.fetchApi("/prompt_presets/save_preset", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ name, positive, negative })
                        });
                        const res = await response.json();
                        
                        if (res.success) {
                        } else {
                            console.error(`PromptPresets: ❌ auto-save failed — ${res.error || "unknown error"}`);
                        }
                    } catch (error) {
                        console.error("PromptPresets: ❌ auto-save request failed", error);
                    }
                }
                
                // Принудительное сохранение перед генерацией, если есть несохранённые изменения
                async function forceAutoSaveBeforeQueue() {
                    if (!isAutoSaveEnabled()) return;
                    if (isProgrammatic || creatingNew) return;
                    
                    const positive = positiveWidget.value;
                    const negative = negativeWidget.value;
                    
                    if (positive !== lastSnapshot.positive || negative !== lastSnapshot.negative) {
                        clearTimeout(autoSaveTimer); // отменяем отложенное сохранение
                        await doAutoSave(); // сохраняем синхронно
                    }
                }
                
                // Поллим значения полей и выбранный пресет: так ловим правки и смену пресета
                // независимо от того, как именно ComfyUI сообщает об изменениях.
                const pollId = setInterval(() => {
                    if (isProgrammatic || creatingNew) return;
                    
                    // Если изменился выбранный пресет И включен авто-сейв → подгружаем
                    if (isAutoSaveEnabled() && presetWidget.value !== lastSnapshot.preset) {
                        loadPresetByName(presetWidget.value);
                        return; // loadPresetByName обновит snapshot
                    }
                    
                    // Если изменились поля И включен авто-сейв И таймер ещё не идёт → планируем сохранение
                    if (isAutoSaveEnabled() &&
                        !autoSaveTimer &&
                        (positiveWidget.value !== lastSnapshot.positive ||
                         negativeWidget.value !== lastSnapshot.negative)) {
                        scheduleAutoSave();
                    }
                }, POLL_INTERVAL);
                
                // Убираем старый перехват callback — теперь всё через поллинг
                // (callback в ComfyUI иногда не срабатывает на программное изменение value)
                
                // Обновление внешнего вида тумблера; заполняется ниже, когда создана кнопка
                let refreshAutoSaveButton = () => {};
                // Обновление счётчика токенов; заполняется ниже, когда создан контейнер
                let refreshTokenCount = () => {};
                let tokenPollId = null;
                let tokenTimer = null;
                let lastTokenSnapshot = { positive: null, negative: null };
                let tokenRequestSeq = 0;
                
                // ===== ОБЩИЙ КОНТЕЙНЕР ДЛЯ ВСЕХ КНОПОК =====
                if (typeof node.addDOMWidget === "function") {
                    const buttonsContainer = document.createElement("div");
                    buttonsContainer.style.cssText = `
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                        width: 100%;
                        box-sizing: border-box;
                        padding: 0;
                        margin: 0;
                        pointer-events: none;
                    `;
                    
                    // ===== СЧЁТЧИК ТОКЕНОВ QWEN-3 0.6B =====
                    const tokenCounter = document.createElement("div");
                    tokenCounter.style.cssText = `
                        display: flex;
                        justify-content: space-between;
                        gap: 8px;
                        padding: 0 2px;
                        height: 16px;
                        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
                        font-size: 10px;
                        line-height: 16px;
                        color: #9ca3af;
                        pointer-events: none;
                        user-select: none;
                    `;
                    tokenCounter.title = "Токены Qwen-3 0.6B тем же токенизатором, что у Anima. camera_input не учтён; >200 — мягкий порог затухания хвоста.";
                    const posTokenEl = document.createElement("span");
                    const negTokenEl = document.createElement("span");
                    tokenCounter.appendChild(posTokenEl);
                    tokenCounter.appendChild(negTokenEl);
                    buttonsContainer.appendChild(tokenCounter);

                    const TOKEN_WARN = 200;

                    function renderTokenCounts(pos, neg) {
                        posTokenEl.textContent = `pos ${pos} tok`;
                        negTokenEl.textContent = `neg ${neg} tok`;
                        posTokenEl.style.color = pos > TOKEN_WARN ? "#fbbf24" : "";
                        negTokenEl.style.color = neg > TOKEN_WARN ? "#fbbf24" : "";
                    }

                    async function fetchTokenCounts() {
                        const positive = positiveWidget.value || "";
                        const negative = negativeWidget.value || "";
                        if (positive === lastTokenSnapshot.positive &&
                            negative === lastTokenSnapshot.negative) {
                            return;
                        }
                        lastTokenSnapshot = { positive, negative };
                        const seq = ++tokenRequestSeq;
                        try {
                            const response = await api.fetchApi("/prompt_presets/token_count", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ positive, negative })
                            });
                            if (!response.ok) throw new Error(`HTTP ${response.status}`);
                            const data = await response.json();
                            if (seq !== tokenRequestSeq) return;
                            if (data.error) throw new Error(data.error);
                            renderTokenCounts(data.positive ?? 0, data.negative ?? 0);
                        } catch (error) {
                            if (seq !== tokenRequestSeq) return;
                            posTokenEl.textContent = "pos —";
                            negTokenEl.textContent = "neg —";
                            console.warn("PromptPresets: token count failed", error);
                        }
                    }

                    function scheduleTokenCount() {
                        clearTimeout(tokenTimer);
                        tokenTimer = setTimeout(fetchTokenCounts, 250);
                    }

                    refreshTokenCount = scheduleTokenCount;
                    scheduleTokenCount();

                    tokenPollId = setInterval(() => {
                        if (positiveWidget.value !== lastTokenSnapshot.positive ||
                            negativeWidget.value !== lastTokenSnapshot.negative) {
                            scheduleTokenCount();
                        }
                    }, 700);

                    // ===== AUTO-SAVE TOGGLE =====
                    const autoSaveButton = document.createElement("button");
                    autoSaveButton.type = "button";
                    
                    function refreshAutoSaveButtonImpl() {
                        const on = isAutoSaveEnabled();
                        autoSaveButton.textContent = on ? "🔁 Auto-save: On" : "⏸️ Auto-save: Off";
                        autoSaveButton.title = on
                            ? "Правки сохраняются в выбранный пресет автоматически"
                            : "Правки сохраняются только кнопкой Save Preset";
                        autoSaveButton.style.cssText = `
                            ${baseButtonStyle()}
                            width: 100%;
                            background: ${on ? "rgba(34, 197, 94, 0.15)" : "rgba(255,255,255,0.045)"};
                            border-color: ${on ? "rgba(34, 197, 94, 0.3)" : "rgba(255,255,255,0.10)"};
                        `;
                    }
                    refreshAutoSaveButton = refreshAutoSaveButtonImpl;
                    
                    autoSaveButton.onmouseenter = () => {
                        autoSaveButton.style.background = isAutoSaveEnabled()
                            ? "rgba(34, 197, 94, 0.25)" : "rgba(255,255,255,0.09)";
                    };
                    autoSaveButton.onmouseleave = () => {
                        refreshAutoSaveButton();
                    };
                    
                    autoSaveButton.onclick = () => {
                        node.properties = node.properties || {};
                        node.properties[AUTO_SAVE_KEY] = !isAutoSaveEnabled();
                        refreshAutoSaveButton();
                        // При включении берём текущее состояние за точку отсчёта,
                        // чтобы не сохранять что-то сгоряча.
                        takeSnapshot();
                    };
                    
                    refreshAutoSaveButton();
                    
                    // ===== NEW PRESET BUTTON =====
                    const newButton = document.createElement("button");
                    newButton.type = "button";
                    newButton.textContent = "✨ New Preset";
                    newButton.style.cssText = `
                        ${baseButtonStyle()}
                        width: 100%;
                        background: rgba(168, 85, 247, 0.15);
                        border-color: rgba(168, 85, 247, 0.3);
                    `;
                    
                    newButton.onmouseenter = () => {
                        newButton.style.background = "rgba(168, 85, 247, 0.25)";
                        newButton.style.borderColor = "rgba(168, 85, 247, 0.4)";
                    };
                    newButton.onmouseleave = () => {
                        newButton.style.background = "rgba(168, 85, 247, 0.15)";
                        newButton.style.borderColor = "rgba(168, 85, 247, 0.3)";
                    };
                    
                    newButton.onclick = () => {
                        isProgrammatic = true;
                        creatingNew = true;
                        positiveWidget.value = "";
                        negativeWidget.value = "";
                        presetNameWidget.value = "My Preset";
                        takeSnapshot();
                        isProgrammatic = false;
                        refreshTokenCount();
                    };
                    
                    // ===== LOAD BUTTON =====
                    const loadButton = document.createElement("button");
                    loadButton.type = "button";
                    loadButton.textContent = "Load Preset";
                    loadButton.style.cssText = `
                        ${baseButtonStyle()}
                        width: 100%;
                        background: rgba(34, 197, 94, 0.15);
                        border-color: rgba(34, 197, 94, 0.3);
                    `;
                    
                    loadButton.onmouseenter = () => {
                        loadButton.style.background = "rgba(34, 197, 94, 0.25)";
                        loadButton.style.borderColor = "rgba(34, 197, 94, 0.4)";
                    };
                    loadButton.onmouseleave = () => {
                        loadButton.style.background = "rgba(34, 197, 94, 0.15)";
                        loadButton.style.borderColor = "rgba(34, 197, 94, 0.3)";
                    };
                    
                    loadButton.onclick = () => {
                        loadPresetByName(presetWidget.value);
                    };
                    
                    // ===== SAVE BUTTON =====
                    const saveButton = document.createElement("button");
                    saveButton.type = "button";
                    saveButton.textContent = "💾 Save Preset";
                    saveButton.style.cssText = `
                        ${baseButtonStyle()}
                        width: 100%;
                        background: rgba(59, 130, 246, 0.15);
                        border-color: rgba(59, 130, 246, 0.3);
                    `;
                    
                    saveButton.onmouseenter = () => {
                        saveButton.style.background = "rgba(59, 130, 246, 0.25)";
                        saveButton.style.borderColor = "rgba(59, 130, 246, 0.4)";
                    };
                    saveButton.onmouseleave = () => {
                        saveButton.style.background = "rgba(59, 130, 246, 0.15)";
                        saveButton.style.borderColor = "rgba(59, 130, 246, 0.3)";
                    };
                    
                    saveButton.onclick = () => {
                        const name = presetNameWidget.value.trim();
                        if (!name) {
                            console.warn("PromptPresets: preset name is empty");
                            return;
                        }
                        
                        const data = {
                            name: name,
                            positive: positiveWidget.value,
                            negative: negativeWidget.value
                        };
                        
                        api.fetchApi("/prompt_presets/save_preset", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(data)
                        })
                        .then(response => response.json())
                        .then(result => {
                            if (result.success) {
                                
                                creatingNew = false;
                                takeSnapshot();
                                
                                // Обновляем список и переключаемся на сохранённый пресет
                                refreshPresetList().then(() => {
                                    presetWidget.value = name;
                                    takeSnapshot();
                                });
                            } else {
                                console.error(`Error saving preset: ${result.error || "Unknown error"}`);
                            }
                        })
                        .catch(error => {
                            console.error("PromptPresets: save failed", error);
                        });
                    };
                    
                    // ===== DELETE BUTTON =====
                    const deleteButton = document.createElement("button");
                    deleteButton.type = "button";
                    deleteButton.textContent = "🗑️ Delete Preset";
                    deleteButton.style.cssText = `
                        ${baseButtonStyle()}
                        width: 100%;
                        background: rgba(239, 68, 68, 0.15);
                        border-color: rgba(239, 68, 68, 0.3);
                    `;
                    
                    deleteButton.onmouseenter = () => {
                        deleteButton.style.background = "rgba(239, 68, 68, 0.25)";
                        deleteButton.style.borderColor = "rgba(239, 68, 68, 0.4)";
                    };
                    deleteButton.onmouseleave = () => {
                        deleteButton.style.background = "rgba(239, 68, 68, 0.15)";
                        deleteButton.style.borderColor = "rgba(239, 68, 68, 0.3)";
                    };
                    
                    deleteButton.onclick = () => {
                        const selectedPreset = presetWidget.value;
                        
                        if (!confirm(`Are you sure you want to delete preset "${selectedPreset}"?`)) {
                            return;
                        }
                        
                        api.fetchApi("/prompt_presets/delete_preset", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ name: selectedPreset })
                        })
                        .then(response => response.json())
                        .then(result => {
                            if (result.success) {
                                
                                isProgrammatic = true;
                                creatingNew = false;
                                
                                // Очищаем поля и выбираем первый доступный пресет
                                positiveWidget.value = "";
                                negativeWidget.value = "";
                                takeSnapshot();
                                isProgrammatic = false;
                                
                                refreshPresetList().then(() => {
                                    if (presetWidget.options.values.length > 0) {
                                        presetWidget.value = presetWidget.options.values[0];
                                    }
                                });
                            } else {
                                console.error(`Error deleting preset: ${result.error || "Unknown error"}`);
                            }
                        })
                        .catch(error => {
                            console.error("PromptPresets: delete failed", error);
                        });
                    };
                    
                    // Собираем кнопки в контейнер
                    buttonsContainer.appendChild(autoSaveButton);
                    buttonsContainer.appendChild(newButton);
                    buttonsContainer.appendChild(loadButton);
                    buttonsContainer.appendChild(saveButton);
                    buttonsContainer.appendChild(deleteButton);
                    
                    // Добавляем контейнер как ОДИН DOM-виджет
                    node.addDOMWidget("buttons_group", "div", buttonsContainer);
                }
                
                // Восстанавливаем состояние тумблера при загрузке воркфлоу
                const originalOnConfigure = node.onConfigure;
                node.onConfigure = function() {
                    const r = originalOnConfigure?.apply(this, arguments);
                    refreshAutoSaveButton();
                    takeSnapshot();
                    refreshTokenCount();
                    return r;
                };
                
                // Чистим таймеры при удалении ноды
                const originalOnRemoved = node.onRemoved;
                node.onRemoved = function() {
                    clearInterval(pollId);
                    clearTimeout(autoSaveTimer);
                    clearInterval(tokenPollId);
                    clearTimeout(tokenTimer);
                    return originalOnRemoved?.apply(this, arguments);
                };
                
                // Перехватываем Queue Prompt — если авто-сохранение включено и есть несохранённые изменения,
                // принудительно сохраняем ДО постановки в очередь.
                node._forceAutoSaveBeforeQueue = forceAutoSaveBeforeQueue;
                
                return result;
            };
        }
    },
    
    // Перехватываем queuePrompt глобально — перед постановкой в очередь вызываем forceAutoSaveBeforeQueue
    // у всех нод PromptPresetsNode
    async beforeQueued(graph) {
        const presetsNodes = graph._nodes?.filter(n => n.type === "PromptPresetsNode") || [];
        for (const node of presetsNodes) {
            if (typeof node._forceAutoSaveBeforeQueue === "function") {
                await node._forceAutoSaveBeforeQueue();
            }
        }
    }
});
