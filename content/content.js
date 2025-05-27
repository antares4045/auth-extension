const currentLocation = window.location
// Ждём полной загрузки DOM
document.addEventListener('DOMContentLoaded', () => {

    chrome.storage.sync.get(['instances', 'activeInstances'], async ({ instances = {}, activeInstances = [] }) => {
    const currentOrigin = window.location.origin;
    const config = instances[currentOrigin];
    
    console.log("currentOrigin: ", currentOrigin)
    
    if (!config || !activeInstances.includes(currentOrigin)) return;
    
    try {
        switch (config.authMethod) {
        case 'aes-ecb':
            token = await getAESToken(config);
            break;
        }
        
    } catch (error) {
        console.error(`[Auth Injector] Ошибка для ${currentOrigin}:`, error);
    }
    });





    // AES-ECB авторизация
    async function getAESToken({ login, password, endpoint = '/api', host = '' }) {
        
        let token;
        const tokenKey = "token";
        const apiUrl = host+endpoint;


        const requestToBridge =  (command, params=null) => {
            const myHeaders = new Headers();
            myHeaders.append("Content-Type", "application/x-www-form-urlencoded");

            const urlencoded = new URLSearchParams();
            urlencoded.append("code", command);
            urlencoded.append("token", localStorage.getItem(tokenKey));
            if(params)
                urlencoded.append("params", JSON.stringify(params));

            const requestOptions = {
                method: "POST",
                headers: myHeaders,
                body: urlencoded,
                redirect: "follow"
            };

            return fetch(apiUrl, requestOptions)
        }

        if(localStorage.getItem(tokenKey)){
            try{
                if((await requestToBridge("CMS.USER.GET_SETTINGS")).status == 200)
                {
                    console.log("и без нашей помощи залогинены")
                    return;
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

            chrome.storage.local.get('originalUrl', ({ originalUrl }) => {
                console.log(`[Auth Injector] редирект на ${originalUrl}.`);
                if (originalUrl && location.href !== originalUrl) {
                    location.replace(originalUrl);
                }
            });
        }
    }

    // // JWT авторизация
    // async function getJWTToken({ login, password, loginEndpoint = '/auth/login' }) {
    // const response = await fetch(loginEndpoint, {
    //     method: 'POST',
    //     body: JSON.stringify({ username: login, password })
    // });
    // return response.json().then(data => data.access_token);
    // }
})