import json

from campus_bounds import footprint
from ground_materials import game_cover
from street_projection import OUT,reproject


def restore_survey_inventory(current,previous):
    current['shrubs']=previous['shrubs']
    current['observations']={**previous['observations'],'sports':current['observations']['sports']}
    current['context']['trees']=previous['context']['trees']


def bake():
    pack=json.loads(OUT.read_bytes())
    network=json.loads(OUT.with_name('drive-network.json').read_bytes())
    landcover=game_cover(footprint(),network)
    restore_survey_inventory(landcover,pack['landcover'])
    pack['landcover']=landcover
    reproject(pack)


if __name__=='__main__':
    bake()
