# GitHub Pages 前端接入

Books 的静态页面继续放在 GitHub Pages。认证接口运行在 VPS，页面通过 `books-auth.js` 请求同一套注册、登录、退出和权限接口。

部署前在站点根目录复制 `books-auth-config.example.js` 为 `books-auth-config.js`，把 API 地址改成 VPS 的 HTTPS 域名：

```js
window.BOOKS_API_BASE = 'https://books-api.example.com';
```

然后在需要登录的页面加载两个脚本：

```html
<script src="books-auth-config.js"></script>
<script src="books-auth.js"></script>
```

`BooksAuth.me()` 可读取当前会话和权限，`BooksAuth.login()`、`BooksAuth.register()`、`BooksAuth.logout()` 负责认证，`BooksAuth.adminUsers()` 和 `BooksAuth.disableUser(id)` 受管理员权限保护。

GitHub Pages 和 VPS 属于不同来源时，VPS 必须把 GitHub Pages 的准确 HTTPS 来源加入允许列表，并返回 `Access-Control-Allow-Credentials: true`。会话 Cookie 需要 `Secure; SameSite=None`。允许列表只接受明确的站点来源，不使用 `*`。

认证接通前可使用 `auth.html` 进行本地页面验证。服务端的 `/api/orders`、`/api/trades` 和 `/api/copy` 继续保持禁用，页面不会创建真实订单。
