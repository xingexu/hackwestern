export async function drivingMenu(page,open=true){
  if(!await page.evaluate(()=>matchMedia('(pointer:coarse)').matches))return
  const button=page.locator('#mobile-menu-toggle')
  await button.waitFor()
  const shown=await button.getAttribute('aria-expanded')==='true'
  if(shown===open)return
  if(open)await button.click()
  else await page.getByRole('button',{name:'Close driving menu'}).click()
}
