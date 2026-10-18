# 04 · Tiempo real (Socket.io)

> **Alcance:** conexión, autenticación, salas y catálogo de eventos del canal en vivo.
> **Audiencia:** frontend web y app móvil.

---

## 1. Principios

- Socket.io comparte **el mismo puerto y servidor HTTP** del API (`src/server.ts`).
- **HTTP es la fuente de verdad.** Los eventos son notificaciones de empuje; todo lo emitido es recuperable por REST. Los clientes deben mantener un polling de respaldo (30–60 s) y recargar el estado al reconectar.
- Transportes: `websocket` y `polling`.

## 2. Conexión y autenticación

El handshake acepta el JWT de acceso por tres vías, en este orden:

1. Header `Authorization: Bearer <jwt>`
2. `auth.token` del handshake (`io(url, { auth: { token } })`)
3. Cookie `gamc_access` (web, mismo sitio)

```ts
// Web (cookies del mismo sitio)
const socket = io(API_URL, { withCredentials: true });

// App móvil
const socket = io(API_URL, { auth: { token: accessToken }, transports: ['websocket'] });
```

Un token ausente o inválido rechaza la conexión con el error `unauthorized`. Al expirar el access token, el cliente debe renovarlo y reconectar.

## 3. Salas

| Sala | Miembros | Contenido |
|---|---|---|
| `dashboard` | Todos los usuarios web | Eventos **globales**: ubicación, estado, SOS, turnos |
| `epi:global` | Super Admin | Todos los eventos **territoriales** |
| `epi:{epiId}` | Usuarios web cuya EPI está activa | Eventos territoriales de su EPI |
| `user:{userId}` | Cada usuario web | Control: permite cerrar sus conexiones |
| `guardia:{guardiaId}` | El guardia | Canal propio; **no** recibe el canal web |

Las salas se calculan al conectar. Cuando cambia la EPI de un usuario, el servidor cierra sus sockets (`desconectarUsuario`) y al reconectar recibe las salas nuevas.

Un dato territorial sin EPI (pendiente de clasificar) solo llega a `epi:global`.

## 4. Catálogo de eventos

| Evento | Alcance | Emisor | Disparador |
|---|---|---|---|
| `guardia:ubicacion` | Global | telemetry, guardias | Nuevo ping GPS |
| `telemetria` | Global | telemetry | Nuevo ping GPS (forma cruda) |
| `guardia:estado` | Global | guardias, turnos | Cambio de estado operativo/cuenta, inicio/cierre de turno |
| `sos:nuevo` | Global | telemetry, guardias | Ping con `esSos: true` o paso a `emergencia` |
| `sos:atendido` | Global | guardias (sos.service) | Operador atiende alertas (incluye sus ids) |
| `turno:iniciado` | Global | turnos | Guardia inicia turno |
| `turno:finalizado` | Global | turnos | Guardia cierra turno |
| `hecho:actualizado` | Territorial | hechos, mandados | Alta, cambio de estado o reclasificación de un hecho |
| `mandado:nuevo` | Territorial | mandados | Nuevo mandado |
| `patrulla:asignada` | Territorial | ejecuciones, planificador, turnos | Asignación o paso a "en curso" |
| `patrulla:cancelada` | Territorial | ejecuciones, puntos-fijos | Retiro, cancelación, cierre por vencimiento |
| `patrulla:estado_ruta` | Territorial | telemetry, incorporación | Cambio a incorporándose / en ruta / advertencia / alerta |
| `punto_fijo:actualizado` | Territorial | puntos-fijos | Alta, edición, traslado o desactivación |
| `programacion:actualizada` | Territorial | programación, automática, ejecuciones | Cambio de programación u horario; cambio del planificador (`epiId: null`) |

### Ejemplos de payload

```json
// patrulla:asignada
{ "ejecucionId": "…", "epiId": "…", "guardiaIds": ["…"], "patrullaIds": ["…"], "puntoFijoId": null }

// patrulla:cancelada (por vencimiento)
{ "ejecucionId": "…", "epiId": "…", "guardiaIds": ["…"], "motivo": "vencida" }

// programacion:actualizada
{ "programacionId": "…", "estado": "activa", "nombre": "Plaza Principal — mañana" }
```

> Los payloads son orientativos para invalidar caché. Ante cualquier evento, la práctica recomendada es volver a pedir el recurso afectado por REST.
