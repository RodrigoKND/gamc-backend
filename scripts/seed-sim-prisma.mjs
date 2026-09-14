import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const db = new PrismaClient();
const HASH = '$2a$12$0ygOYnFJsLsyTGD5NWGInOmW1zxlQOqKBAWf7/EnC5ZNwFTp2RL8G'; // Guardia#2025

const EPI_COORDS = {
  norte: { lat: -17.37, lng: -66.16 },
  central: { lat: -17.3935, lng: -66.1653 },
  sud: { lat: -17.42, lng: -66.17 },
  cona_cona: { lat: -17.38, lng: -66.19 },
  centro_cercado: { lat: -17.395, lng: -66.155 },
};

function jitter(base, delta=0.02){ return base + (Math.random()-0.5)*delta; }

const NOMBRES = [
  ['Juan','Carlos','Quispe','Mamani'], ['Luis','Fernando','Rojas','Vargas'],
  ['Miguel','Angel','Torrez','Heredia'], ['Diego',null,'Flores','Condori'],
  ['Roberto','Carlos','Mendoza','Aguilar'], ['Jorge',null,'Pereira','Soto'],
  ['Andres','Felipe','Gutierrez','Luna'], ['Marco','Antonio','Vargas','Choque'],
  ['Pablo',null,'Silva','Reyes'], ['Eduardo','Jose','Ortiz','Paz'],
  ['Victor','Hugo','Cespedes','Zamora'], ['Daniel',null,'Aguirre','Cruz'],
  ['Oscar','Emilio','Barrientos','Veizaga'], ['Raul',null,'Escobar','Molina'],
  ['Cristian','David','Ledezma','Pinto'], ['Marcelo',null,'Antezana','Rivera'],
  ['Alex',null,'Mercado','Camacho'], ['Henry',null,'Claros','Teran'],
];

async function main(){
  const maria = await db.user.findUnique({where:{email:'maria.rojas@cochabamba.bo'}});
  if(!maria) throw new Error('maria no existe');
  const epis = await db.epi.findMany();
  const epiByCodigo = new Map(epis.map(e=>[e.codigo,e]));
  const tipos = await db.tipoHecho.findMany();
  
  console.log('Insertando guardias...');
  for(let i=0;i<NOMBRES.length;i++){
    const n=NOMBRES[i];
    const ci=`8000${String(100+i).padStart(3,'0')}`;
    const epiKeys=Object.keys(EPI_COORDS);
    const epiCodigo=epiKeys[i%epiKeys.length];
    const epi=epiByCodigo.get(epiCodigo);
    const estadoOperativo = i%7===0?'emergencia': i%5===0?'fuera_de_servicio':'en_servicio';
    const usuario = `${n[0].toLowerCase()}${ci.slice(-2)}_${i}`;
    try{
      await db.guardia.upsert({
        where:{ci},
        update:{estadoOperativo, estado:'activo', passwordHash:HASH},
        create:{
          epiId: epi?.id ?? null,
          primerNombre:n[0], segundoNombre:n[1], apellidoPaterno:n[2], apellidoMaterno:n[3],
          ci, usuario, passwordHash:HASH, telefono:`76${String(100000+i).padStart(6,'0')}`,
          fechaNacimiento:new Date(1990+(i%12),(i%12),10+(i%18)),
          estado:'activo', estadoOperativo, debeCambiarPassword:false, creadoPorId:maria.id
        }
      });
    }catch(e){ console.warn('skip',ci,JSON.stringify(e.meta??e.message).slice(0,500)); }
  }
  console.log('Guardias OK',await db.guardia.count());

  console.log('Rutas...');
  for(const epi of epis){
    const base=EPI_COORDS[epi.codigo]??EPI_COORDS.central;
    for(let k=0;k<3;k++){
      const nombre=`Ruta ${epi.nombre} ${k+1}`;
      if(await db.rutaPlantilla.findFirst({where:{nombre}})) continue;
      const delta=0.004+Math.random()*0.003;
      const trazado={type:'Polygon',coordinates:[[[base.lng-delta,base.lat-delta],[base.lng+delta,base.lat-delta],[base.lng+delta,base.lat+delta],[base.lng-delta,base.lat+delta],[base.lng-delta,base.lat-delta]]]};
      await db.rutaPlantilla.create({data:{nombre, descripcion:`Patrullaje ${epi.nombre}`, epiId:epi.id, trazado, activo:true, creadoPorId:maria.id}});
    }
  }
  console.log('Rutas OK',await db.rutaPlantilla.count());

  const todas = await db.guardia.findMany({where:{estado:'activo'}});
  const now=new Date();
  console.log('Turnos+Telemetria...',todas.length);
  for(const g of todas){
    if(g.estadoOperativo==='fuera_de_servicio') continue;
    let turno = await db.turno.findFirst({where:{guardiaId:g.id, estado:'en_servicio'}});
    if(!turno){
      const epi = g.epiId ? epis.find(e=>e.id===g.epiId) : null;
      const coord = epi? EPI_COORDS[epi.codigo]??EPI_COORDS.central : EPI_COORDS.central;
      turno = await db.turno.create({data:{
        guardiaId:g.id, estado:'en_servicio', selfieInicioUrl:'https://example.com/selfie.jpg',
        latInicio:jitter(coord.lat,0.015), lngInicio:jitter(coord.lng,0.015),
        horainicio:new Date(now.getTime()-Math.random()*3*3600*1000)
      }});
    }
    const existsTele = await db.guardiaTelemetria.count({where:{turnoId:turno.id}});
    if(existsTele>0) continue;
    const epi = g.epiId ? epis.find(e=>e.id===g.epiId) : null;
    const coord = epi? EPI_COORDS[epi.codigo]??EPI_COORDS.central : EPI_COORDS.central;
    const esSos = g.estadoOperativo==='emergencia';
    for(let p=0;p<3;p++){
      let bat = Math.floor(15+Math.random()*85);
      if(g.ci==='7564321' && p===0) bat=12;
      if(g.ci==='8123456' && p===0) bat=18;
      await db.guardiaTelemetria.create({data:{
        guardiaId:g.id, turnoId:turno.id,
        lat:jitter(coord.lat,0.01), lng:jitter(coord.lng,0.01),
        precisionM: Math.round((5+Math.random()*15)*100)/100,
        velocidadMps: Math.round(Math.random()*10*10)/10,
        bateriaPct:bat, esSos, sosEstado: esSos?'pendiente':null,
        capturadoEn:new Date(now.getTime()-p*90*1000 - Math.random()*30*1000)
      }});
    }
  }
  console.log('Telemetria OK',await db.guardiaTelemetria.count());

  console.log('Hechos...');
  const hechosCount = await db.hecho.count();
  if(hechosCount<10){
    for(let i=0;i<30;i++){
      const rg = todas[Math.floor(Math.random()*todas.length)];
      const tipo=tipos[Math.floor(Math.random()*tipos.length)];
      const epi=epis[Math.floor(Math.random()*epis.length)];
      const base=EPI_COORDS[epi.codigo]??EPI_COORDS.central;
      const nivels=['bajo','medio','alto','muy_alto'];
      const estados=['reportado','en_revision','cerrado'];
      const nivel=nivels[Math.floor(Math.random()*nivels.length)];
      const estado=estados[Math.floor(Math.random()*estados.length)];
      const turno=await db.turno.findFirst({where:{guardiaId:rg.id}});
      const hecho=await db.hecho.create({data:{
        guardiaId:rg.id, turnoId:turno?.id??null, tipoHechoId:tipo.id,
        descripcion:`${tipo.label} reportado en ${epi.nombre} - caso sim #${i+1}`,
        nivelRiesgo:nivel, lat:jitter(base.lat,0.02), lng:jitter(base.lng,0.02),
        epiId:epi.id, direccion:`Av. Sim ${i+1}, ${epi.nombre}`,
        ocurridoEn:new Date(now.getTime()-Math.random()*7*24*3600*1000), estado
      }});
      await db.hechoEvidencia.create({data:{hechoId:hecho.id, url:`https://picsum.photos/seed/gamc-hecho-${i}/400/300`, tipo:'foto'}});
    }
  }
  console.log('Hechos OK',await db.hecho.count());

  console.log('Patrullas...');
  const rutas=await db.rutaPlantilla.findMany();
  let pc=0;
  // Usa queryRaw para evitar bug de Prisma generate con fecha
  const hoyRows = await db.$queryRaw`SELECT guardia_id::text as gid FROM patrulla WHERE fecha = CURRENT_DATE`;
  const conPatrullaHoy = new Set(hoyRows.map(r=>r.gid));
  for(let i=0;i<Math.min(6,todas.length);i++){
    const g=todas[i];
    if(conPatrullaHoy.has(g.id)) continue;
    const ruta=rutas[i%rutas.length];
    await db.patrulla.create({data:{
      guardiaId:g.id, rutaPlantillaId:ruta?.id??null, epiId:g.epiId, asignadoPorId:maria.id,
      estado: Math.random()>0.5?'asignada':'en_curso', fecha:new Date(),
      nombre:ruta?.nombre??`Patrulla sim ${i+1}`, descripcion:'Ruta asignada por seed',
      poligonoGeojson: ruta?.trazado ?? undefined, iniciadaEn:new Date()
    }});
    pc++;
  }
  console.log('Patrullas creadas',pc);

  console.log('Zonas...');
  await db.zonaCriticaActiva.updateMany({where:{vigente:true},data:{vigente:false}});
  const desde=new Date(now.getTime()-7*24*3600*1000);
  const byEpi=await db.hecho.groupBy({by:['epiId'], where:{ocurridoEn:{gte:desde}}, _count:{id:true}});
  for(const g of byEpi){
    if(!g.epiId) continue;
    const hechos=await db.hecho.findMany({where:{epiId:g.epiId, ocurridoEn:{gte:desde}}, select:{lat:true,lng:true,nivelRiesgo:true}});
    if(!hechos.length) continue;
    const lat=hechos.reduce((s,h)=>s+h.lat,0)/hechos.length;
    const lng=hechos.reduce((s,h)=>s+h.lng,0)/hechos.length;
    const peso={bajo:1,medio:2,alto:3,muy_alto:4};
    const nivel=hechos.reduce((a,b)=> peso[b.nivelRiesgo]>peso[a.nivelRiesgo]?b:a, hechos[0]).nivelRiesgo;
    await db.zonaCriticaActiva.create({data:{epiId:g.epiId, centroLat:lat, centroLng:lng, radioM:500, cantidadHechos:hechos.length, nivelRiesgo:nivel, ventanaDesde:desde, ventanaHasta:now, vigente:true}});
  }
  console.log('Zonas OK',await db.zonaCriticaActiva.count({where:{vigente:true}}));

  const hoyCountRows = await db.$queryRaw`SELECT count(*)::int as c FROM patrulla WHERE fecha = CURRENT_DATE`;
  const final = {
    guardias: await db.guardia.count(),
    turnos: await db.turno.count({where:{estado:'en_servicio'}}),
    telemetria: await db.guardiaTelemetria.count(),
    hechos: await db.hecho.count(),
    zonas: await db.zonaCriticaActiva.count({where:{vigente:true}}),
    rutas: await db.rutaPlantilla.count(),
    patrullasHoy: Number(hoyCountRows[0]?.c ?? 0),
  };
  console.table(final);
  const ops=await db.guardia.groupBy({by:['estadoOperativo'],_count:{_all:true}});
  console.log('estados',ops);
  await db.$disconnect();
  console.log('DONE');
}
main().catch(async e=>{console.error(e); await new PrismaClient().$disconnect(); process.exit(1);});
