# Исследование закрытия ручного ввода — 0.6.8-test.2

Статус: живая трасса получена. В наблюдаемом прогоне после подтверждения остаётся панель DLNA Bridge; пользователь подтвердил конечный экран. Прежнее закрытие панели в этом прогоне не воспроизведено. Новое восстановление не добавлялось.

## Проверенное окружение

- ADB MEmu: `127.0.0.1:21503`, пакет `top.rootu.lampa`, 1.13.6, versionCode 586.
- Native settings: URL оболочки `http://lampa.mx`.
- В журнале Local Storage есть URL `v068-test2/plugin.js` со status 1; это запись настройки расширения, не доказательство исполнения callback.
- `/proc/net/unix` не содержит WebView DevTools socket. `run-as` сообщает, что пакет не debuggable.
- ADB имеет root-доступ; данные прочитаны без изменения приложения.
- Два снимка Android чёрные. Windows Computer Use: `FrameArrived timed out` / `window capture timed out`. Дерево UI содержит WebView без элементов Lampa.

## Исходник из кеша данного MEmu

Из `cache/WebView/Default/HTTP Cache/Cache_Data/4e0f92a1309583b8_0` извлечён `http://lampa.mx/app.min.js?v=1993940`.
Файл для проверки: `evidence/lampa-cached.js`. Это статический кеш, не трасса исполнения.

- Строки 58055+: обработчик Keyboard.enter вызывает `back()`, затем `call(input_value)`.
- Строки 58140+: `back()` вызывает `destroy$1()`, затем переключается в верхнее окно, если оно совпадает с `opened_from`, иначе в `settings_component`.
- Строки 58437+: callback Params.input записывает Storage, обновляет поле и вызывает `onChange(new_value)`.
- Строки 57630+: DOM keyup редактора вызывает blur, затем Keyboard.enter. Window keyup также имеет обработчик Keypad (строки 4524+). Наличие обработчиков не доказывает их фактический порядок/результат в проблемном прогоне.

## Расхождение регрессионной модели

`tests/component-ui.test.js`, helper `confirmAddress`:

- Вместо реального Input/Keyboard явно переключает контроллер на `head` и задаёт `settingsVisible = false`.
- Затем записывает Storage и синхронно вызывает onChange.
- Не выполняет DOM-событие подтверждения, уничтожение Keyboard, возвращение `settings_component`, всплытие keyup, возможные последующие обработчики и отложенные закрытия.
- Не моделирует фактическое обновление текста поля Params.input.

Поэтому PASS test.2 подтверждает восстановление из искусственно заданного состояния. Он не доказывает устранение пользовательского дефекта.

## Наблюдатель

Отдельный `observe-input.js`, URL `http://192.168.1.69:18768/observe-input.js`, добавляется рядом с test.2. Он не заменяет плагин.
Снимает Input.edit/callback, Keyboard.destroy/enter/back/blur, запись ключа активного адреса (без значения), onChange, Controller.toggle/back/enter, Settings.create/open/close, DOM capture/window keyup/keydown/click и изменения класса body.
Каждое событие включает номер, время, контроллер, видимость settings/input, идентификатор фокуса и компонент Activity.
События сохраняются локально в `evidence/input-trace.jsonl`; в памяти доступны через `window.__dlnaInputObserver`.
Обёртки вызывают оригинальные функции синхронно, сохраняя this, аргументы, результат и исключения. Небольшое влияние наблюдения на время исполнения возможно.

До получения живой трассы нельзя приписывать выход конкретному keyup, Back, onChange или закрытию Settings.

## Живая трасса и уточнение пользователя

`evidence/input-trace.jsonl`, session `1794546850051`, события 37–61:

1. `Keyboard.send blur` → DOM capture click → blur → `Keyboard.send enter` (37–40).
2. `Keyboard.destroy` (41–42), затем `Controller.toggle(settings_component)` (43–45). Ввод уже закрыт, настройки всё ещё открыты; фокус на `dlna_bridge_server_url`.
3. `Input.callback:enter` (46), `Storage.set` активного адреса (47–48).
4. Внутри callback идёт `Controller.toggle(settings)` (49–52): `Settings.open main`, фокус на `dlna_bridge` в главных настройках.
5. Затем `Settings.create(dlna_bridge)` (53–58): `Settings.open dlna_bridge`, контроллер `settings_component`, фокус на адресе.
6. `Input.callback:exit` (59), body mutation и window click (60–61). Конечное состояние: settings=true, input=false, activity=main, controller=settings_component, focus=dlna_bridge_server_url.

`Settings.close`, Controller.back и переход в `head`/`extensions_line` в этом подтверждении отсутствуют. Это подтверждение кликом, не клавиатурным keyup. Последующие отдельные действия пользователя не моделируются этой последовательностью.

Пользователь уточнил конечный экран: **«Панель DLNA Bridge с кнопками серверов»**. Следовательно, наблюдаемый «выход в меню плагина» — возврат из редактора в нужную панель, а не закрытие этой панели.

Прямых событий `address.onChange` в этой сессии нет: observer.ready пришёл при пустом контроллере до регистрации параметров, и обёртка onChange не была установлена. Переходы 49–58 находятся внутри Input.callback и совпадают с текущим кодом onChange test.2; это сопоставление кода и трассы, а не отдельный вход/выход обёртки onChange.

Установлена причина промежуточного захода в главные настройки: явные вызовы `Controller.toggle('settings')` и `Settings.create(COMPONENT)` в test.2. Причина прежнего пользовательского закрытия панели не установлена, потому что такое закрытие в этой трассе отсутствует. Снятие или изменение этих вызовов в рамках исследования не выполнялось.

Вывод по регрессионной модели сохраняется: искусственный переход на head не соответствует данной живой трассе. Полная приёмка ввода/нового значения адреса, клавиатурного подтверждения и повторных прогонов по этой трассе не объявляется.

## Сохранность

SHA-256 рабочего test.2 до и после исследования: `2716D7A52C8703B6D304A6B81729DB53C08D37EDCC037A3FA4B882DA614FC886`.
`plugin.js`, тесты, защита поколений и Android pending-lock в этом исследовании не менялись. Новые файлы только для наблюдения и отчёта; локальная раздача дополнена сбором трассы. Публикация не выполнялась.
