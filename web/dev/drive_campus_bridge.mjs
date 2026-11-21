import assert from 'node:assert/strict';
import {join} from 'node:path';

export async function driveCampusBridge(page,out){
  await page.selectOption('#drive-course','roam');
  await page.getByRole('button',{name:'Restart'}).click();
  const start=await page.evaluate(()=>{
    const {network,surveyView}=window.driveMetrics;
    const x=669,z=378.94,heading=Math.atan2(88.84,16.77);
    const approach=network.sample(x,z);
    surveyView({x,y:approach.y,z,heading,pitch:0});
    return {x,z,heading};
  });
  await page.waitForTimeout(650);
  await page.screenshot({path:join(out,'campus-bridge-approach.png')});
  await page.keyboard.down('ArrowUp');
  try{
    await page.waitForFunction(()=>window.driveMetrics.car.x>717,null,{timeout:15000});
    await page.screenshot({path:join(out,'campus-bridge-on-deck.png')});
    await page.waitForFunction(()=>window.driveMetrics.car.x>767,null,{timeout:12000});
  }finally{await page.keyboard.up('ArrowUp');}
  const end=await page.evaluate(()=>{
    const {car,network}=window.driveMetrics;
    return {x:car.x,z:car.z,speed:car.speed,surface:network.sample(car.x,car.z,car.y).surface};
  });
  const lateral=(end.x-start.x)*Math.cos(start.heading)-(end.z-start.z)*Math.sin(start.heading);
  assert.equal(end.surface,'road');
  assert.ok(Math.abs(lateral)<3.6 && end.speed>5,JSON.stringify(end));
  console.log('Crossed both University Drive bridge abutments in the browser with the accelerator held, '+Math.round(end.x-start.x)+' metres east.');
}
