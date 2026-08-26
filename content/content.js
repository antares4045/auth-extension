function onFinish(state) {
    switch(state){
        case '':
            chrome.runtime.sendMessage({
                action: 'set-badge',
                text: '',
                color: '#999999'
            });
            break;
        case 'ok':
            chrome.runtime.sendMessage({
                action: 'set-badge',
                text: '✓'
            });
            break;
        case 'active':
            chrome.runtime.sendMessage({
                action: 'set-badge',
                text: '⯈'
            });
            break;
        case 'fail':
            chrome.runtime.sendMessage({
                action: 'set-badge',
                text: '✖',
                color: '#ff0000'
            });

            
    }
}

var apiUrl;
const tokenKey = "token";
const encodeFormBody = (fields) => Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
const DEFAULT_BRIDGE_TIMEOUT_MS = 30000;
const REPORT_SETTING_TIMEOUT_MS = 5000;

const requestToBridge = async (
    command,
    params = null,
    useReceives = false,
    { signal, timeoutMs = DEFAULT_BRIDGE_TIMEOUT_MS } = {},
) => {
        const myHeaders = new Headers();
        myHeaders.append("Content-Type", "application/x-www-form-urlencoded");

        // URLSearchParams кодирует пробел как "+". Старый REP bridge ожидает
        // percent-encoding (%20), в том числе внутри JSON-поля params.
        const urlencoded = encodeFormBody({
            code: command,
            // CMS.INIT_APP исторически получает token=null до авторизации.
            token: localStorage.getItem(tokenKey) ?? 'null',
            format: 'JSON',
            receiver: useReceives ? sessionStorage.getItem("receiver") : null,
            streamreceiver: useReceives ? sessionStorage.getItem("streamreceiver") : null,
            params: params ? JSON.stringify(params) : null,
        });

        const controller = new AbortController();
        let timedOut = false;
        const abortFromCaller = () => controller.abort(signal?.reason);
        if (signal?.aborted) abortFromCaller();
        else signal?.addEventListener('abort', abortFromCaller, { once: true });
        const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, timeoutMs)
            : null;
        const requestOptions = {
            method: "POST",
            headers: myHeaders,
            body: urlencoded,
            redirect: "follow",
            signal: controller.signal,
        };

        try {
            const response = await fetch(apiUrl, requestOptions);
            const responseText = await response.text();
            return {
                ok: response.ok,
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                url: response.url,
                redirected: response.redirected,
                text: async () => responseText,
                json: async () => JSON.parse(responseText),
            };
        } catch (error) {
            if (!controller.signal.aborted) throw error;
            if (timedOut) {
                throw new Error(`${command}: превышено время ожидания (${timeoutMs} мс)`);
            }
            throw new Error(`${command}: запрос отменён`);
        } finally {
            if (timeout !== null) clearTimeout(timeout);
            signal?.removeEventListener('abort', abortFromCaller);
        }
    }

async function requestJsonFromBridge(command, params = null, useReceives = false, options = {}) {
    if (!localStorage.getItem(tokenKey)) {
        throw new Error('В localStorage нет token — сначала авторизуйтесь');
    }
    if (useReceives && (!sessionStorage.getItem('receiver') || !sessionStorage.getItem('streamreceiver'))) {
        throw new Error('В sessionStorage нет receiver/streamreceiver — откройте отчёт заново');
    }
    if (!apiUrl) {
        const { instances = {} } = await chrome.storage.sync.get('instances');
        updateApiUrl(instances[window.location.origin]);
    }

    const response = await requestToBridge(command, params, useReceives, options);
    if (!response.ok) throw new Error(`${command}: HTTP ${response.status}`);

    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`${command}: сервер вернул не JSON`);
    }
}

globalThis.AuthInjectorBridge = Object.freeze({
    requestJson: requestJsonFromBridge,
});

function updateApiUrl({endpoint = '/api', host = '' }={})
{
    const localStorageIP = localStorage.getItem("IP");
    apiUrl = localStorageIP || host+endpoint;
}

// Ждём полной загрузки DOM
 function tryLogin(){

    chrome.storage.sync.get(['instances', 'activeInstances'], async ({ instances = {}, activeInstances = [] }) => {
    const currentOrigin = window.location.origin;
    const config = instances[currentOrigin];
    
    console.log("currentOrigin: ", currentOrigin);
    updateApiUrl(config);

    if (!config || !activeInstances.includes(currentOrigin)) return onFinish('');
    let state;
    try {
        switch (config.authMethod) {
        case 'aes-ecb':
            state = await getAESToken(config);
            break;
        }
        
    } catch (error) {
        console.error(`[Auth Injector] Ошибка для ${currentOrigin}:`, error);
        state = "fail";
    }
    onFinish(state);
    });





    // AES-ECB авторизация
    async function getAESToken({ login, password}) {
        
        let token;
        
        const localStorageIP = localStorage.getItem("IP");
        if(localStorageIP){
            chrome.runtime.sendMessage({
                action: 'set-badge',
                color: '#ffd700'
            });
        }else{
            chrome.runtime.sendMessage({
                action: 'set-badge',
                color: '#28a745'
            });
        }

        if(localStorage.getItem(tokenKey)){
            try{
                if((await requestToBridge("CMS.USER.GET_SETTINGS")).status == 200)
                {
                    console.log("и без нашей помощи залогинены")
                    return 'ok';
                }
            }catch (error){
                //pass
                console.log("надо логиниться - токен мёртв")
            }
            
        }else{
            console.log("нет токена")
        }

        const pkRequest = await requestToBridge("CMS.INIT_APP");
        const key = (await pkRequest.json())["pk"];
        


        const encrypted = CryptoJS.AES.encrypt(
            CryptoJS.enc.Utf8.parse(password),
            CryptoJS.enc.Utf8.parse(key),
            {
            mode: CryptoJS.mode.ECB,
            padding: CryptoJS.pad.Pkcs7
            }
        );

        const encodedPassword = CryptoJS.enc.Base64.stringify(encrypted.ciphertext);
       
        const loginRequest = await requestToBridge("CMS.LOGIN", {"userName":login,"password":encodedPassword,"authType":"SYSTEM"})
        const loginResponse = await loginRequest.json()
        token = loginResponse["token"];

        if (token) {
            localStorage.setItem(tokenKey, token);

            localStorage.setItem("isAuth", true);
            localStorage.setItem("userInfo", loginResponse["userName"]);
            localStorage.setItem("userId", loginResponse["user_id"]);
            localStorage.setItem("apps", JSON.stringify({"SL":1,"REP":1,"AUD":1,"ADM":1,"CN":1,"DOC":1,"BIN":1,"SCH":1}	)); //тут хардкод - извините
            localStorage.setItem("userLogin", login	);
            localStorage.setItem("userLogin", "[Auth Injector] не знает имён");
           

            // const originalUrl = localStorage.getItem("originalUrl");
             console.log(`[Auth Injector] Токен сохранён.`);

            chrome.runtime.sendMessage({ action: 'get-original-url' }, (response) => {
                const originalUrl = response?.originalUrl;
                console.log(`[Auth Injector] редирект на ${originalUrl}.`);
                if (originalUrl && location.href !== originalUrl) {
                    location.replace(originalUrl);
                }
            });
        }
        return 'active'
    }

}



// Добавляем обработчик сообщений от попапа
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getSetting') {
        // Асинхронно получаем значение настройки
        getCurrentSetting(message.params).then(value => {
            sendResponse({ success: true, value: "ФД " + value });
        }).catch(error => {
            console.error("Ошибка получения настройки:", error);
            sendResponse({ success: false, error: error.message });
        });
        return true; // Сообщаем, что ответ будет отправлен асинхронно
    }
    if (message.action === 'toggleSetting') {
        toggleSetting(message.params).then(newValue => {
            sendResponse({ success: true, newValue: "ФД " + newValue });
        }).catch(error => {
            console.error("Ошибка переключения настройки:", error);
            sendResponse({ success: false, error: error.message });
        });
        return true;
    }
});

// Функция для получения текущего значения настройки
async function getCurrentSetting(params = null) {
    // Используем существующую requestToBridge
    const response = await requestToBridge(
        'REP.GET_REPORT_SETTINGS',
        params,
        true,
        { timeoutMs: REPORT_SETTING_TIMEOUT_MS },
    );
    if (!response.ok) throw new Error('Failed to get setting');
    const data = await response.json();
    
    
    return (data?.settings?.engineVersion || "?");
}

// Функция для переключения настройки
async function toggleSetting(params = null) {
    // Сначала получаем текущее значение
    const currentValue = await getCurrentSetting(params);
    const newValue = currentValue == "4" ? "3" : "4";
    // Отправляем запрос на установку нового значения
    const updateResponse = await requestToBridge(
        'REP.SET_REPORT_SETTINGS',
        { "settings": {"engineVersion": newValue} },
        true,
        { timeoutMs: REPORT_SETTING_TIMEOUT_MS },
    );
    if (!updateResponse.ok) throw new Error('Failed to toggle setting');
    return newValue;
}

document.addEventListener('DOMContentLoaded', tryLogin)
