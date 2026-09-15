import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
async function main(){
  // simula crearHechoMovil
  const guardia = await db.guardia.findFirst({ select:{id:true, epiId:true}});
  console.log('guardia', guardia);
  if(!guardia) {console.log('no guardia'); await db.$disconnect(); return;}
  const tipo = await db.tipoHecho.findUnique({where:{codigo:'robo'}});
  console.log('tipo robo', tipo);
  const tipo2 = await db.tipoHecho.findUnique({where:{codigo:'violencia'}});
  console.log('tipo violencia', tipo2);
  const allTipos = await db.tipoHecho.findMany({select:{codigo:true}});
  console.log('all', allTipos.map(t=>t.codigo));
  // intenta crear hecho
  try{
    const created = await db.hecho.create({
      data:{
        guardiaId: guardia.id,
        turnoId: null,
        tipoHechoId: tipo.id,
        descripcion: 'Prueba desde script - robo test',
        nivelRiesgo: 'alto',
        lat: -17.3935,
        lng: -66.1570,
        epiId: guardia.epiId,
        direccion: null,
        ocurridoEn: new Date(),
        estado: 'reportado',
        evidencias: {create: [{url:'https://example.com/foto.jpg', tipo:'foto'}]}
      },
      include:{ tipoHecho:true, evidencias:true}
    });
    console.log('created OK', created.id, created.ocurridoEn.toISOString());
    const count = await db.hecho.count();
    console.log('count after', count);
    // limpia prueba
    await db.hechoEvidencia.deleteMany({where:{hechoId: created.id}});
    await db.hecho.delete({where:{id: created.id}});
    console.log('cleaned');
  }catch(e){
    console.error('CREATE FAILED', e);
    console.error(e.message);
    if(e.code) console.error('code', e.code);
    if(e.meta) console.error('meta', e.meta);
  }
  await db.$disconnect();
}
main();
